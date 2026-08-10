// Servo-Plucked-Strings-GMB — ESP32-S3 firmware entry point.
//
// Wires the pure-core logic (src/core/) to the ESP32 platform adapters
// (src/platform/esp32/). The core is unit-tested on the host; this file is the
// hardware integration and runs only on device.
//
// Servo-per-fret model: there is NO stepper carriage and NO homing. Each fret
// position on a string has its own dedicated finger servo; to play a fretted note
// the firmware releases the finger currently pressed on that string, presses the
// target fret's finger, lets it settle, then plucks. Fret 0 (open) presses no
// finger. A ServoActivationGovernor staggers the finger presses of a chord so the
// PCA9685 in-rush current stays bounded (together with per-servo disableAtRest and
// the one-finger-per-string release-before-press sequence).
//
// Boot sequence (spec §21.1 / §13, adapted): power-on safe → validate profile →
// park every finger at rest → arm for play.
#if defined(ARDUINO)

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include <atomic>
#include <vector>

#include "core/configuration/Profile.h"
#include "core/configuration/PluckPlan.h"
#include "core/configuration/ProfileValidator.h"
#include "core/gmb/GmbSysExService.h"
#include "core/instrument/InstrumentController.h"
#include "core/instrument/ServoActivationGovernor.h"
#include "core/midi/MidiEvent.h"
#include "core/safety/SafetyManager.h"
#include "core/util/Debounce.h"
#include "platform/esp32/MidiWifi.h"
#include "platform/esp32/Net.h"
#include "platform/esp32/ProfileStorage.h"
#include "platform/esp32/ServoBank.h"
#include "platform/esp32/WebApi.h"

using namespace gmb;

namespace {

Profile g_profile;
ProfileStorage g_storage;
SafetyManager g_safety;
InstrumentController g_instrument;
GmbSysExService g_sysex;
ServoBank g_servos;
ServoActivationGovernor g_governor;
Net g_net;
MidiWifi g_midi;
WebApi g_web;

enum class AppPhase { Boot, Reconfiguring, Ready };
AppPhase g_phase = AppPhase::Boot;
bool g_degraded = false;  // Ready but with one or more strings disabled by a fault

// Two-phase profile activation: the OLD profile's fingers are driven to rest and
// allowed to lift BEFORE the old servo config is destroyed, so a profile that
// removes/reassigns a finger servo can't leave a finger pressed while the new
// profile arms. Non-null while an activation is waiting for the old fingers.
Profile* g_pendingProfile = nullptr;
uint32_t g_pendingActivateAtMs = 0;

std::vector<bool> g_stringFaulted;   // runtime fault (servo write error, etc.)
std::vector<int> g_currentFinger;    // PCA/GPIO servo index currently pressed, or -1

int8_t g_estopPin = -1;
Debouncer g_estopDeb;  // debounced E-stop input (avoids a spurious trip)

// BOOT button (GPIO0) forces the Wi-Fi hotspot (AP + captive portal) on a long
// press, so a wrong station config can never lock the user out. GPIO0 is the
// universal ESP32 dev-board BOOT button — held LOW while pressed (INPUT_PULLUP).
// A ~2 s hold avoids accidental triggers; the switch is live (no reboot).
constexpr uint8_t kBootButtonPin = 0;
constexpr uint32_t kBootHoldMs = 2000;
uint32_t g_bootDownAtMs = 0;
bool g_bootWasDown = false;
bool g_bootTriggered = false;

// Pending test-note Note Offs (scheduled by /api/test/note).
struct TestNoteOff { uint8_t channel; uint8_t note; uint32_t atMs; };
std::vector<TestNoteOff> g_testOffs;

// Per-string non-blocking playback scheduler.
struct StringSched {
    enum Phase { Idle, WaitStopped, ReleasingFinger, PressingFinger, Settling, Ready,
                 StrumLiftDown, StrumLiftHold }
        phase = Idle;
    uint32_t phaseStartMs = 0;
    uint32_t commandId = 0;
    int fingerIndex = -1;        // target fret's finger servo (-1 = open / none)
    uint16_t releaseWaitMs = 0;  // time to wait for the previous finger to lift
    uint32_t dampUntilMs = 0;    // don't press until the damper has acted (replace)
    int liftIndex = -1;          // engaged strum-lift servo during a stroke
    int strikeIndex = -1;        // striker to fire once the lift has lowered
    int muteIndex = -1;          // plectrum/lift held against the string to damp (Note Off)
    uint32_t executeAtMs = 0;    // earliest time the note may sound (fixed delay)
    uint32_t readyAtMs = 0;      // when the string became Ready (anchors fretToPluckMs)
    bool executeAnchored = false;
    bool fingerPressStarted = false;  // press begun (after a governor permit)
    bool fingerSweep = false;         // direct A<->B sweep on one geared servo (no neutral)
    uint16_t fingerMoveMs = 0;        // time budget for the current finger move (press/sweep)
    uint32_t liftStartMs = 0;
    bool liftStarted = false;
};
std::vector<StringSched> g_sched;

// ---- Web -> loop() command queue (P0: no mechanical state off the main loop) --
enum class CmdType : uint8_t { Panic, Reset, ActivateProfile, TestNote, TestServo };
struct AppCommand {
    CmdType type;
    uint32_t id = 0;
    Profile* profile = nullptr;
    uint8_t channel = 0, note = 0, velocity = 0;
    uint16_t durationMs = 0;
    int16_t servoIndex = -1;
    bool servoActive = false;
    uint16_t servoUs = 0;  // >0: drive the test servo to this exact pulse (live cal)
};

std::atomic<uint32_t> g_nextCmdId{1};
struct CmdResult { uint32_t id = 0; uint8_t state = 0; };  // 0=queued 1=done 2=refused
constexpr int kCmdResultRing = 16;
CmdResult g_cmdResults[kCmdResultRing];
SemaphoreHandle_t g_resultMutex = nullptr;

void setCommandResult(uint32_t id, uint8_t state) {
    if (id == 0) return;
    if (g_resultMutex) xSemaphoreTake(g_resultMutex, portMAX_DELAY);
    for (auto& r : g_cmdResults)
        if (r.id == id) { r.state = state; if (g_resultMutex) xSemaphoreGive(g_resultMutex); return; }
    static int next = 0;
    g_cmdResults[next] = {id, state};
    next = (next + 1) % kCmdResultRing;
    if (g_resultMutex) xSemaphoreGive(g_resultMutex);
}

std::string commandStateStr(uint32_t id) {
    const char* s = "unknown";
    if (g_resultMutex) xSemaphoreTake(g_resultMutex, portMAX_DELAY);
    for (const auto& r : g_cmdResults)
        if (r.id == id) { s = r.state == 0 ? "queued" : r.state == 1 ? "succeeded" : "refused"; break; }
    if (g_resultMutex) xSemaphoreGive(g_resultMutex);
    return s;
}
QueueHandle_t g_cmdQueue = nullptr;
SemaphoreHandle_t g_stateMutex = nullptr;
SemaphoreHandle_t g_storageMutex = nullptr;
std::atomic<bool> g_panicRequested{false};
std::atomic<bool> g_hotspotRequested{false};  // BOOT button / web -> force AP
bool g_authConfiguredCache = false;

uint32_t enqueueCommand(const AppCommand& in) {
    if (!g_cmdQueue) return 0;
    AppCommand c = in;
    c.id = g_nextCmdId.fetch_add(1);
    AppCommand* h = new AppCommand(c);
    if (xQueueSend(g_cmdQueue, &h, 0) != pdTRUE) {
        delete h->profile;
        delete h;
        return 0;
    }
    setCommandResult(c.id, 0);
    return c.id;
}

struct StateGuard {
    StateGuard() { if (g_stateMutex) xSemaphoreTake(g_stateMutex, portMAX_DELAY); }
    ~StateGuard() { if (g_stateMutex) xSemaphoreGive(g_stateMutex); }
};

int8_t pinOf(const char* signal) {
    for (const auto& a : g_profile.pins)
        if (a.signal == signal) return a.gpio;
    return -1;
}

// Reallocates the per-string vectors + reinitialises the servo hardware. The
// CALLER must hold g_stateMutex around this (and the g_profile assignment that
// precedes an activation) so a web read never observes the runtime half-rebuilt.
void applyProfile() {
    g_instrument.load(g_profile);
    g_sysex.rebuild(g_profile);
    g_sched.assign(g_profile.strings.size(), StringSched{});
    g_currentFinger.assign(g_profile.strings.size(), -1);
    g_stringFaulted.assign(g_profile.strings.size(), false);

    // Overlay the global plucking gesture onto the strikers so the bank drives one
    // common gesture for every string (stroke time + minimum strike depth). A zero
    // global leaves each servo untouched (historical behaviour); the profile itself
    // keeps the per-servo values intact.
    std::vector<ServoConfig> servos = g_profile.servos;
    for (auto& s : servos) {
        if (s.function == "pluck" || s.function == "strum") {
            // Overlay the global gesture via the unit-tested PluckPlan helpers so the
            // runtime and the tests can never drift (both are no-ops when the global
            // fields are zero, preserving the historical per-servo values) — audit P-B9.
            s.strokeMs = effectivePluckStrokeMs(g_profile.pluck, s);
            s.minStrikeUs = effectivePluckMinStrikeUs(g_profile.pluck, s);
        }
        // A raise-to-play strum lift damps by resting ON the string, so it must stay
        // energised at rest for the mute to hold — override disableAtRest regardless
        // of the profile (audit P-B5).
        if (s.function == "strumLift" &&
            g_profile.pluck.liftEngage == LiftEngage::RaiseToPlay)
            s.disableAtRest = false;
    }
    g_servos.begin(servos, pinOf("SDA"), pinOf("SCL"), pinOf("SERVO_OE"));
    g_governor.configure(g_profile.power.maxConcurrentMoves, g_profile.power.staggerMs);

    // The E-stop pin belongs to the (possibly new) profile.
    g_estopPin = pinOf("ESTOP");
    if (g_estopPin >= 0) pinMode(g_estopPin, INPUT_PULLUP);
    g_estopDeb.configure(3, true);  // idle = HIGH (not pressed, active-low input)
}

// Rebuild the capability snapshot from a runtime copy of the profile that
// excludes every disabled or runtime-faulted string, and update g_degraded.
int rebuildRuntimeCapabilities() {
    StateGuard lock;
    Profile rp = g_profile;
    int originallyEnabled = 0, ready = 0;
    for (size_t i = 0; i < rp.strings.size(); ++i) {
        if (g_profile.strings[i].enabled) ++originallyEnabled;
        if (!rp.strings[i].enabled || (i < g_stringFaulted.size() && g_stringFaulted[i]))
            rp.strings[i].enabled = false;
        else
            ++ready;
    }
    g_degraded = ready < originallyEnabled;
    g_profile.capabilitiesRevision++;
    rp.capabilitiesRevision = g_profile.capabilitiesRevision;
    g_sysex.rebuild(rp);
    return ready;
}

void notifyCapabilitiesChanged() {
    if (!g_midi.hasLastSender()) return;
    // GMB v2 block 0x11 change flags: bit 1 = INSTRUMENTS_CHANGED (the capability
    // set / string config moved). GMB uses it only as a cue to re-read the
    // handshake and compare the revision, so an approximate flag is fine.
    std::vector<uint8_t> msg = g_sysex.notification(0x02);
    if (!msg.empty()) g_midi.notifyLastSender(msg.data(), msg.size());
}

void neutraliseAll();  // fwd

// Lift the finger currently pressed on a string (if any). Returns its travel time
// so the caller can wait for it to physically lift before pressing the next one.
uint16_t releaseCurrentFinger(size_t i) {
    if (i >= g_currentFinger.size()) return 0;
    int fi = g_currentFinger[i];
    if (fi < 0) return 0;
    g_servos.release(fi);
    g_currentFinger[i] = -1;
    return g_servos.travelMs(fi);
}

// Central runtime string-fault path (servo write error, PCA loss on one board…).
void faultRuntimeAxis(size_t i, const char* reason, uint32_t nowMs) {
    if (i >= g_instrument.stringCount()) return;
    g_instrument.faultString(i);
    // Physically release anything this string had engaged.
    releaseCurrentFinger(i);
    if (i < g_sched.size()) {
        if (g_sched[i].liftIndex >= 0) g_servos.release(g_sched[i].liftIndex);
        g_sched[i] = StringSched{};
    }
    if (i < g_stringFaulted.size()) g_stringFaulted[i] = true;
    g_safety.recordFault("string", std::string(reason) + " on string " + std::to_string(i),
                         nowMs);
    int working = rebuildRuntimeCapabilities();
    notifyCapabilitiesChanged();
    if (working <= 0) {
        neutraliseAll();
        g_safety.panic("no operational strings remain", nowMs);
    }
}

bool safetyLocked() {
    SafetyState s = g_safety.state();
    return s == SafetyState::Panic || s == SafetyState::EmergencyStop;
}

// Park every finger at rest and arm for play. No homing: servos have known
// positions. Refuses if a panic/E-stop is latched, the profile is invalid, or a
// servo/PCA channel could not attach or respond (spec §13/§21).
bool armInstrument(uint32_t nowMs) {
    if (safetyLocked()) return false;
    if (g_estopPin >= 0 && digitalRead(g_estopPin) == LOW) {
        g_safety.emergencyStop(nowMs);
        return false;
    }
    if (!ProfileValidator::isActivatable(g_profile)) return false;
    if (g_servos.directAttachFault() || g_servos.pcaAttachFault()) {
        g_safety.recordFault("attach", "a servo/PCA9685 could not attach or respond", nowMs);
        return false;
    }
    g_safety.reset();  // -> PowerOnSafe
    g_degraded = false;
    g_governor.reset();
    for (size_t i = 0; i < g_profile.strings.size(); ++i) {
        if (!g_profile.strings[i].enabled)
            g_instrument.string(i).disable();  // a disabled string never plays
        if (i < g_currentFinger.size()) g_currentFinger[i] = -1;
    }
    g_servos.neutraliseAll();     // all servos to rest (fingers up)
    g_servos.outputEnable(true);  // keep outputs live for play
    g_phase = AppPhase::Ready;
    g_safety.arm(true, true);     // profile already validated
    return true;
}

// Explicit recovery after a panic / E-stop.
bool doReset(uint32_t nowMs) {
    if (g_estopPin >= 0 && digitalRead(g_estopPin) == LOW) return false;
    if (!ProfileValidator::isActivatable(g_profile)) return false;
    if (g_servos.directAttachFault() || g_servos.pcaAttachFault()) return false;
    g_safety.reset();
    g_safety.clearFaults();
    for (size_t i = 0; i < g_stringFaulted.size(); ++i) {
        if (g_stringFaulted[i]) {
            g_stringFaulted[i] = false;
            g_instrument.recoverString(i);
        }
    }
    return armInstrument(nowMs);
}

void neutraliseAll() {
    g_instrument.panic();
    g_servos.neutraliseAll();
    g_governor.reset();
    for (auto& s : g_sched) s = StringSched{};
    for (auto& f : g_currentFinger) f = -1;
    g_testOffs.clear();
    delete g_pendingProfile;
    g_pendingProfile = nullptr;
    g_phase = AppPhase::Boot;
}

void doPanic() {
    neutraliseAll();
    if (g_safety.state() != SafetyState::EmergencyStop)
        g_safety.panic("web/CC panic", millis());
}

void doEmergencyStop() {
    neutraliseAll();
    g_safety.emergencyStop(millis());
}

// ---- loop-side command handlers (only ever called from drainCommands) --------

// Phase 1 of activation: validate, release the OLD profile's fingers, and defer
// the teardown until they have physically lifted (servicePendingActivation).
bool doActivateProfile(const Profile& p, uint32_t nowMs) {
    if (!ProfileValidator::isActivatable(p)) return false;
    if (safetyLocked()) return false;
    g_instrument.panic();
    for (auto& s : g_sched) s = StringSched{};
    g_testOffs.clear();
    g_safety.reset();
    g_phase = AppPhase::Reconfiguring;

    // Drive every current servo to rest (fingers up) before the old config is
    // destroyed, and wait for the slowest to travel + settle.
    g_servos.outputEnable(true);
    uint32_t wait = 0;
    for (size_t i = 0; i < g_servos.count(); ++i) {
        g_servos.release(static_cast<int>(i));
        uint32_t w = static_cast<uint32_t>(g_servos.travelMs(static_cast<int>(i))) +
                     g_servos.settleMs(static_cast<int>(i));
        if (w > wait) wait = w;
    }
    for (auto& f : g_currentFinger) f = -1;
    delete g_pendingProfile;
    g_pendingProfile = new Profile(p);
    g_pendingActivateAtMs = nowMs + wait;
    return true;
}

// Phase 2: once the old fingers have lifted, tear down and swap in the new one.
void servicePendingActivation(uint32_t nowMs) {
    if (!g_pendingProfile) return;
    if (static_cast<int32_t>(nowMs - g_pendingActivateAtMs) < 0) return;
    g_servos.neutraliseAll();
    {
        StateGuard lock;
        g_profile = *g_pendingProfile;
        g_profile.capabilitiesRevision++;
        applyProfile();
    }
    delete g_pendingProfile;
    g_pendingProfile = nullptr;
    if (!armInstrument(nowMs)) g_phase = AppPhase::Boot;
}

bool doTestNote(uint8_t channel, uint8_t note, uint8_t vel, uint16_t durationMs,
                uint32_t nowMs) {
    if (g_phase != AppPhase::Ready) return false;
    if (channel > 15 || note > 127 || vel > 127) return false;
    if (durationMs > 10000) durationMs = 10000;
    if (g_testOffs.size() >= 16) return false;
    MidiEvent on;
    on.type = static_cast<uint8_t>(MidiType::NoteOn);
    on.channel = channel; on.data1 = note; on.data2 = vel;
    on.timestampUs = micros();
    on.source = static_cast<uint8_t>(MidiSource::WebUiTest);
    g_instrument.handleEvent(on, on.timestampUs);
    uint32_t offAt = nowMs + (durationMs ? durationMs : 500u);
    g_testOffs.push_back({channel, note, offAt});
    return true;
}

// Web servo test: only when armed and only for a real, enabled servo. Used by the
// installation/calibration wizard to press/release one finger at a time. When `us`
// is non-zero the servo is driven to that exact pulse and held, so the wizard can
// preview any calibration angle live — including a geared finger's neutral / press-A
// / press-B positions (the pulse is clamped to the servo's mechanical window).
bool doTestServo(int index, bool active, uint16_t us) {
    if (!g_safety.actuatorsAllowed()) return false;
    if (!g_servos.commandable(index)) return false;
    if (us > 0) return g_servos.holdMicros(index, us);
    if (active) g_servos.press(index); else g_servos.release(index);
    return true;
}

void purgeCommands() {
    if (!g_cmdQueue) return;
    AppCommand* c = nullptr;
    while (xQueueReceive(g_cmdQueue, &c, 0) == pdTRUE) {
        delete c->profile;
        delete c;
    }
}

bool servicePanic(uint32_t nowMs) {
    (void)nowMs;
    if (!g_panicRequested.exchange(false)) return false;
    doPanic();
    purgeCommands();
    return true;
}

// Force the Wi-Fi hotspot (AP + captive portal) from a BOOT-button long-press or a
// web "Start hotspot" request. Runs on the main loop (owns Net + WiFi). Switching
// the radio is independent of the instrument state, so it works in any phase.
void serviceHotspotRequests(uint32_t nowMs) {
    bool down = digitalRead(kBootButtonPin) == LOW;  // active-low BOOT button
    if (down && !g_bootWasDown) { g_bootDownAtMs = nowMs; g_bootTriggered = false; }
    if (down && !g_bootTriggered && nowMs - g_bootDownAtMs >= kBootHoldMs) {
        g_bootTriggered = true;
        g_hotspotRequested.store(true);
    }
    g_bootWasDown = down;
    if (g_hotspotRequested.exchange(false)) {
        g_net.forceAccessPoint();
        Serial.println(F("BOOT/web: forced Wi-Fi hotspot (AP + captive portal)"));
    }
}

void drainCommands(uint32_t nowMs) {
    if (!g_cmdQueue) return;
    static constexpr int kMaxCommandsPerTick = 2;
    AppCommand* c = nullptr;
    for (int n = 0; n < kMaxCommandsPerTick && xQueueReceive(g_cmdQueue, &c, 0) == pdTRUE;
         ++n) {
        bool ok = true;
        switch (c->type) {
            case CmdType::Panic: doPanic(); purgeCommands(); break;
            case CmdType::Reset: ok = doReset(nowMs); break;
            case CmdType::ActivateProfile:
                ok = c->profile && doActivateProfile(*c->profile, nowMs);
                break;
            case CmdType::TestNote:
                ok = doTestNote(c->channel, c->note, c->velocity, c->durationMs, nowMs);
                break;
            case CmdType::TestServo:
                ok = doTestServo(c->servoIndex, c->servoActive, c->servoUs);
                break;
        }
        setCommandResult(c->id, ok ? 1 : 2);
        delete c->profile;
        delete c;
    }
}

// The per-string striker: the plectrum ('pluck') if present, otherwise the
// per-string strum servo ('strum').
int perStringStrikeIndex(size_t i) {
    int p = g_servos.pluckIndex(static_cast<int>(i));
    return p >= 0 ? p : g_servos.strumIndex(static_cast<int>(i));
}

// Drive one string's mechanical sequence toward a plucked note.
void tickString(size_t i, uint32_t nowMs) {
    StringController& sc = g_instrument.string(i);
    const StringTarget& tgt = g_instrument.target(i);
    StringSched& sch = g_sched[i];

    if (!tgt.active) {
        if (sch.phase == StringSched::Idle) return;
        if (sch.phase != StringSched::WaitStopped) {
            // Note released / cancelled: lift the finger, then damp per the global
            // mute policy resolved against what this string actually has wired — a
            // damper servo, the plectrum's own mute angle (rest against the string,
            // no dedicated damper), the strum lift, or nothing.
            sch.releaseWaitMs = releaseCurrentFinger(i);
            if (sch.liftIndex >= 0) { g_servos.release(sch.liftIndex); sch.liftIndex = -1; }
            sch.liftStarted = false;
            sch.muteIndex = -1;

            int di = g_servos.damperIndex(static_cast<int>(i));
            int pi = perStringStrikeIndex(i);
            int li = g_servos.strumLiftIndex(static_cast<int>(i));
            uint32_t muteWaitMs = 0;
            // Raise-to-play: the lift already rests ON the string, so releasing it
            // (just above) mutes — no other actuator should move, and pressing one
            // would fight it. Otherwise damp via the resolved mute source.
            if (!liftMutesAtRest(g_profile.pluck, li >= 0)) {
                bool strikerHasMute = pi >= 0 && g_servos.muteUs(pi) != 0;
                MuteSource action =
                    resolvePluckMute(g_profile.pluck, di >= 0, strikerHasMute, li >= 0);
                switch (action) {
                    case MuteSource::Damper:
                        if (di >= 0) { g_servos.strike(di); muteWaitMs = g_servos.travelMs(di); }
                        break;
                    case MuteSource::Plectrum:
                        // Bring the plectrum to rest against the string to damp it,
                        // then release it to rest once the mute hold has elapsed.
                        if (pi >= 0 && g_servos.muteHold(pi)) {
                            sch.muteIndex = pi;
                            muteWaitMs = g_profile.pluck.muteHoldMs;
                        }
                        break;
                    case MuteSource::Lift:
                        if (li >= 0 && g_servos.press(li)) {
                            sch.muteIndex = li;
                            muteWaitMs = g_profile.pluck.muteHoldMs;
                        }
                        break;
                    default:  // None: let the string ring / decay naturally.
                        break;
                }
                // A lift that doubles as an étouffoir (lower-to-play): lean it on the
                // string at Note Off even when the primary mute came from elsewhere
                // (unless something is already held, so only one is left to release).
                if (g_profile.pluck.liftMuteOnNoteOff && sch.muteIndex < 0 &&
                    action != MuteSource::Lift && li >= 0 && g_servos.press(li)) {
                    sch.muteIndex = li;
                    if (g_profile.pluck.muteHoldMs > muteWaitMs) muteWaitMs = g_profile.pluck.muteHoldMs;
                }
            }
            if (muteWaitMs > sch.releaseWaitMs) sch.releaseWaitMs = muteWaitMs;
            sch.phase = StringSched::WaitStopped;
            sch.phaseStartMs = nowMs;
        }
        // Declare idle once the finger has lifted and any held mute has released.
        if (nowMs - sch.phaseStartMs >= sch.releaseWaitMs) {
            if (sch.muteIndex >= 0) { g_servos.release(sch.muteIndex); sch.muteIndex = -1; }
            sc.dampingDone();
            sch.phase = StringSched::Idle;
            sch.commandId = 0;
        }
        return;
    }

    if (sch.commandId != tgt.commandId) {
        // New note replacing a previous one on this string: damp the still-ringing
        // string and wait for the damper before pressing the new fret.
        sch.dampUntilMs = nowMs;
        if (sch.phase != StringSched::Idle && sch.phase != StringSched::WaitStopped) {
            int di = g_servos.damperIndex(static_cast<int>(i));
            if (di >= 0) {
                g_servos.strike(di);
                sch.dampUntilMs = nowMs + g_servos.travelMs(di) + g_servos.settleMs(di);
            }
        }
        if (sch.liftIndex >= 0) { g_servos.release(sch.liftIndex); sch.liftIndex = -1; }
        // Drop any Note-Off mute still held from the previous note (plectrum against
        // the string, or a lift leaning on it) before starting the new one.
        if (sch.muteIndex >= 0) { g_servos.release(sch.muteIndex); sch.muteIndex = -1; }
        sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
        sch.executeAnchored = sc.willArmOnSettle();
        sch.fingerPressStarted = false;
        sch.liftStarted = false;
        sch.strikeIndex = -1;
        sch.commandId = tgt.commandId;
        // Direct sweep: when the target fret is driven by the SAME servo already
        // pressed — a geared finger's other side, or a re-fret of the same fret —
        // keep it engaged and sweep straight to the new side instead of lifting
        // through neutral (no spurious release, the finger stays powered). Otherwise
        // lift the current finger and wait for it to travel up before pressing the
        // new fret (never two fingers driving at once on a string).
        int prevFinger = i < g_currentFinger.size() ? g_currentFinger[i] : -1;
        int targetFinger = g_servos.fingerIndexForFret(static_cast<int>(i), tgt.fret);
        sch.fingerSweep = (prevFinger >= 0 && targetFinger == prevFinger);
        sch.releaseWaitMs = sch.fingerSweep ? 0 : releaseCurrentFinger(i);
        sch.phase = StringSched::ReleasingFinger;
        sch.phaseStartMs = nowMs;
    }

    // A prepared (anticipated) note is "received" when its Note On triggers it.
    if (!sch.executeAnchored && sc.consumeTriggerEdge()) {
        sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
        sch.executeAnchored = true;
    }

    switch (sch.phase) {
        case StringSched::ReleasingFinger:
            // Once the previous finger has lifted and the damper has acted, select
            // the target fret's finger and advance the FSM (no carriage: instant).
            if (nowMs - sch.phaseStartMs >= sch.releaseWaitMs &&
                static_cast<int32_t>(nowMs - sch.dampUntilMs) >= 0) {
                sch.fingerIndex = g_servos.fingerIndexForFret(static_cast<int>(i), tgt.fret);
                sc.motionReached();  // ReleasingFinger -> Moving -> Pressing/ReadyToPluck
                if (sc.openString()) {
                    sch.phase = StringSched::Ready;  // open: no finger press
                    sch.readyAtMs = nowMs;
                } else if (sch.fingerIndex < 0) {
                    // Fretted note but this fret has no finger servo (a gap / partial
                    // install). Don't hang: advance the FSM so it still plucks the
                    // open string. The validator warns about this configuration.
                    sc.fingerPressed();
                    sc.settled();
                    sch.phase = StringSched::Ready;
                    sch.readyAtMs = nowMs;
                } else {
                    sch.phase = StringSched::PressingFinger;
                    sch.phaseStartMs = nowMs;
                    sch.fingerPressStarted = false;
                }
            }
            break;
        case StringSched::PressingFinger:
            // Ask the governor for a start permit before driving the finger, so a
            // chord's presses are staggered and the PCA in-rush stays bounded.
            if (!sch.fingerPressStarted) {
                if (!g_governor.requestStart(nowMs)) break;  // wait for a permit
                // A direct sweep travels farther than a press from neutral (it crosses
                // the whole A..B span), so budget the wait by the real pulse distance;
                // a normal press from neutral uses the calibrated travelMs. Compute it
                // BEFORE pressFret writes the new target (sweep time reads the current
                // pulse).
                sch.fingerMoveMs = sch.fingerSweep
                    ? g_servos.sweepMsToFret(sch.fingerIndex, tgt.fret)
                    : g_servos.travelMs(sch.fingerIndex);
                // pressFret drives a geared finger toward the correct antagonistic
                // side for tgt.fret (activeUs for side A, activeBUs for side B); for
                // a plain single finger it is identical to press().
                if (!g_servos.pressFret(sch.fingerIndex, tgt.fret)) {
                    faultRuntimeAxis(i, "finger servo write failed", nowMs);
                    break;
                }
                g_currentFinger[i] = sch.fingerIndex;
                sch.fingerPressStarted = true;
                sch.phaseStartMs = nowMs;
            }
            if (nowMs - sch.phaseStartMs >= sch.fingerMoveMs) {
                sc.fingerPressed();
                sch.phase = StringSched::Settling;
                sch.phaseStartMs = nowMs;
            }
            break;
        case StringSched::Settling: {
            // Strum lead: begin lowering the strum lift up to strumLeadMs before the
            // string is Ready (overlaps the lift travel with the finger settle).
            if (!sch.liftStarted && sc.willArmOnSettle() && g_profile.midi.strumLeadMs > 0) {
                int pi = perStringStrikeIndex(i);
                int li = pi >= 0 ? g_servos.strumLiftIndex(static_cast<int>(i)) : -1;
                uint32_t settle = g_servos.settleMs(sch.fingerIndex);
                if (li >= 0 &&
                    (nowMs - sch.phaseStartMs) + g_profile.midi.strumLeadMs >= settle) {
                    if (!g_servos.press(li)) {
                        faultRuntimeAxis(i, "strum lift servo write failed", nowMs);
                        break;
                    }
                    sch.liftIndex = li;
                    sch.strikeIndex = pi;
                    sch.liftStartMs = nowMs;
                    sch.liftStarted = true;
                }
            }
            uint16_t settle = sch.fingerIndex >= 0 ? g_servos.settleMs(sch.fingerIndex) : 0;
            if (nowMs - sch.phaseStartMs >= settle) {
                sc.settled();
                sch.phase = StringSched::Ready;
                sch.readyAtMs = nowMs;  // anchors the fret->pluck delay
            }
            break;
        }
        case StringSched::Ready: {
            if (!sch.executeAnchored && sc.pluckArmed()) {
                sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
                sch.executeAnchored = true;
            }
            if (!sc.pluckArmed()) break;
            // The strike waits for BOTH the fixed Note-On latency (executeAtMs) and
            // the fret->pluck settle measured from when the string became Ready, so a
            // freshly fretted string is given time to stabilise before it is plucked
            // ("delay between fret action and plucking").
            uint32_t strikeAtMs = sch.executeAtMs;
            if (g_profile.pluck.fretToPluckMs != 0) {
                uint32_t floorMs = sch.readyAtMs + g_profile.pluck.fretToPluckMs;
                if (static_cast<int32_t>(floorMs - strikeAtMs) > 0) strikeAtMs = floorMs;
            }
            int pi = perStringStrikeIndex(i);
            // Pre-lower the strum lift DURING the wait so the strike lands AT
            // strikeAtMs even with a lift — the plectrum is in place at the frappe.
            if (pi >= 0 && !sch.liftStarted) {
                int li = g_servos.strumLiftIndex(static_cast<int>(i));
                if (li >= 0) {
                    uint32_t liftMs = g_servos.travelMs(li) + g_servos.engageDelayMs(li);
                    if (static_cast<int32_t>(nowMs - strikeAtMs) +
                            static_cast<int32_t>(liftMs) >= 0) {
                        if (!g_servos.press(li)) {
                            faultRuntimeAxis(i, "strum lift servo write failed", nowMs);
                            break;
                        }
                        sch.liftIndex = li;
                        sch.strikeIndex = pi;
                        sch.liftStartMs = nowMs;
                        sch.liftStarted = true;
                    }
                }
            }
            if (static_cast<int32_t>(nowMs - strikeAtMs) < 0) break;
            if (!sc.executePluck(tgt.commandId)) break;
            if (pi >= 0) {
                int li = sch.liftStarted ? sch.liftIndex
                                         : g_servos.strumLiftIndex(static_cast<int>(i));
                if (li >= 0) {
                    if (!sch.liftStarted) {
                        if (!g_servos.press(li)) {
                            faultRuntimeAxis(i, "strum lift servo write failed", nowMs);
                            break;
                        }
                        sch.liftIndex = li;
                        sch.strikeIndex = pi;
                        sch.liftStartMs = nowMs;
                        sch.liftStarted = true;
                    }
                    sch.phase = StringSched::StrumLiftDown;
                    break;
                }
                g_servos.strike(pi, tgt.intensity);
            }
            break;
        }
        case StringSched::StrumLiftDown:
            if (static_cast<int32_t>(nowMs - (sch.liftStartMs +
                    g_servos.travelMs(sch.liftIndex) +
                    g_servos.engageDelayMs(sch.liftIndex))) >= 0) {
                g_servos.strike(sch.strikeIndex, tgt.intensity);
                sch.phase = StringSched::StrumLiftHold;
                sch.phaseStartMs = nowMs;
            }
            break;
        case StringSched::StrumLiftHold:
            if (nowMs - sch.phaseStartMs >= g_servos.travelMs(sch.strikeIndex)) {
                if (g_profile.pluck.liftEngage == LiftEngage::RaiseToPlay) {
                    // Raise-to-play: KEEP the plectrum lifted (string free to ring)
                    // for the whole note; it falls back onto the string — muting —
                    // only when the lift returns to rest at Note Off.
                    sch.strikeIndex = -1;
                } else {
                    // Lower-to-play: retract the lift now so the plectrum clears the
                    // ringing string.
                    g_servos.release(sch.liftIndex);
                    sch.liftIndex = -1;
                    sch.strikeIndex = -1;
                }
                sch.phase = StringSched::Ready;
            }
            break;
        case StringSched::WaitStopped:
        case StringSched::Idle:
            break;
    }
}

}  // namespace

void setup() {
    Serial.begin(115200);
    g_safety.boot();  // servos neutralised (spec §21.1)

    g_cmdQueue = xQueueCreate(16, sizeof(AppCommand*));
    g_stateMutex = xSemaphoreCreateMutex();
    g_storageMutex = xSemaphoreCreateMutex();
    g_resultMutex = xSemaphoreCreateMutex();

    g_storage.begin();
    if (g_storage.degraded()) {
        g_safety.recordFault("storage",
            "LittleFS unmountable — profiles unavailable; POST /api/storage/format "
            "to reformat", millis());
    }
    // Never configure GPIO / I2C / PCA / LEDC from a profile that fails validation:
    // fall back to the safe default (§21.1).
    if (!g_storage.load(g_storage.startupSlot(), g_profile) ||
        !ProfileValidator::isActivatable(g_profile)) {
        g_profile = Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
    }
    {
        uint64_t mac = ESP.getEfuseMac();
        uint8_t id[5];
        for (int i = 0; i < 5; ++i) id[i] = static_cast<uint8_t>((mac >> (8 * i)) & 0x7F);
        g_sysex.setDeviceId(id);
    }
    { StateGuard lock; applyProfile(); }
    g_sysex.setUseV2(true);

    Preferences prefs;
    prefs.begin("gmb", true);
    String staPass = prefs.getString("wifipass", "");
    String apPass = prefs.getString("appass", "");
    prefs.end();
    g_net.begin(g_profile.network, staPass.c_str(), apPass.c_str());
    g_midi.begin(5006);
    pinMode(kBootButtonPin, INPUT_PULLUP);  // BOOT button -> force hotspot (long press)

    WebContext ctx;
    ctx.profile = &g_profile;
    ctx.instrument = &g_instrument;
    ctx.sysex = &g_sysex;
    ctx.servos = &g_servos;
    ctx.net = &g_net;
    ctx.safety = &g_safety;
    ctx.storage = &g_storage;
    ctx.onPanic = []() { g_panicRequested.store(true); };
    ctx.onStartHotspot = []() { g_hotspotRequested.store(true); };
    ctx.onTestNote = [](uint8_t channel, uint8_t note, uint8_t vel,
                        uint16_t durationMs) -> uint32_t {
        AppCommand c{CmdType::TestNote};
        c.channel = channel; c.note = note; c.velocity = vel;
        c.durationMs = durationMs;
        return enqueueCommand(c);
    };
    ctx.onTestServo = [](int index, bool active, int us) -> uint32_t {
        AppCommand c{CmdType::TestServo};
        c.servoIndex = static_cast<int16_t>(index);
        c.servoActive = active;
        c.servoUs = us > 0 ? static_cast<uint16_t>(us > 65535 ? 65535 : us) : 0;
        return enqueueCommand(c);
    };
    ctx.commandState = [](uint32_t id) -> std::string { return commandStateStr(id); };
    ctx.onFormatStorage = []() -> bool { return g_storage.format(); };
    ctx.lockState = []() { if (g_stateMutex) xSemaphoreTake(g_stateMutex, portMAX_DELAY); };
    ctx.unlockState = []() { if (g_stateMutex) xSemaphoreGive(g_stateMutex); };
    ctx.lockStorage = []() { if (g_storageMutex) xSemaphoreTake(g_storageMutex, portMAX_DELAY); };
    ctx.unlockStorage = []() { if (g_storageMutex) xSemaphoreGive(g_storageMutex); };
    ctx.onSetWifi = [](bool hasSta, const std::string& sta, bool hasAp,
                       const std::string& ap) {
        Preferences p;
        p.begin("gmb", false);
        if (hasSta) p.putString("wifipass", String(sta.c_str()));
        if (hasAp) p.putString("appass", String(ap.c_str()));
        p.end();
    };
    ctx.checkToken = [](const std::string& provided) -> bool {
        Preferences p; p.begin("gmb", true);
        String stored = p.getString("admintoken", ""); p.end();
        if (stored.length() == 0) return true;
        return provided == std::string(stored.c_str());
    };
    ctx.onSetAdminToken = [](const std::string& t) {
        Preferences p; p.begin("gmb", false);
        p.putString("admintoken", String(t.c_str())); p.end();
        g_authConfiguredCache = !t.empty();
    };
    { Preferences p; p.begin("gmb", true);
      g_authConfiguredCache = p.getString("admintoken", "").length() > 0; p.end(); }
    ctx.authConfigured = []() -> bool { return g_authConfiguredCache; };
    ctx.appState = []() -> std::string {
        if (g_phase == AppPhase::Ready) return g_degraded ? "readyDegraded" : "ready";
        if (g_phase == AppPhase::Reconfiguring) return "reconfiguring";
        return "boot";
    };
    ctx.readyStrings = []() -> int {
        if (g_phase != AppPhase::Ready) return 0;
        int n = 0;
        for (size_t i = 0; i < g_profile.strings.size(); ++i)
            if (g_profile.strings[i].enabled &&
                !(i < g_stringFaulted.size() && g_stringFaulted[i])) ++n;
        return n;
    };
    ctx.onActivateProfile = [](const Profile& p) -> uint32_t {
        if (!ProfileValidator::isActivatable(p)) return 0u;
        AppCommand c{CmdType::ActivateProfile};
        c.profile = new Profile(p);
        return enqueueCommand(c);
    };
    ctx.onReset = []() -> uint32_t { return enqueueCommand(AppCommand{CmdType::Reset}); };
    g_web.begin(ctx, 80);

    // No homing: park the fingers and arm straight away. armInstrument() refuses if
    // the profile is invalid or a channel failed to attach, leaving us safely in Boot.
    armInstrument(millis());
    g_web.refreshStatus();
}

void loop() {
    uint32_t nowUs = micros();
    uint32_t nowMs = millis();

    g_net.tick(nowMs);

    // SAFETY FIRST: hardware E-stop (active-low), then the web/CC STOP flag.
    if (g_estopPin >= 0) {
        bool rawPressed = digitalRead(g_estopPin) == LOW;
        bool debouncedPressed = !g_estopDeb.update(nowMs, digitalRead(g_estopPin) == HIGH);
        if ((rawPressed || debouncedPressed) &&
            g_safety.state() != SafetyState::EmergencyStop) {
            doEmergencyStop();
            purgeCommands();
        }
    }
    bool panicked = servicePanic(nowMs);
    serviceHotspotRequests(nowMs);  // BOOT-button / web hotspot (independent of phase)

    if (!panicked) drainCommands(nowMs);
    servicePendingActivation(nowMs);

    // Wi-Fi loss policy: cancel pending commands and release notes, stay armed.
    static bool wasConnected = false;
    bool nowConnected = g_net.connected() && !g_net.accessPointActive();
    if (wasConnected && !nowConnected && g_phase == AppPhase::Ready) {
        g_instrument.panic();
        g_safety.recordFault("wifi", "Wi-Fi link lost — pending commands cancelled", nowMs);
    }
    wasConnected = nowConnected;

    // Deliver any scheduled test-note Note Offs that are due.
    for (size_t k = 0; k < g_testOffs.size();) {
        if ((int32_t)(nowMs - g_testOffs[k].atMs) >= 0) {
            MidiEvent off;
            off.type = static_cast<uint8_t>(MidiType::NoteOff);
            off.channel = g_testOffs[k].channel; off.data1 = g_testOffs[k].note;
            off.timestampUs = nowUs;
            g_instrument.handleEvent(off, nowUs);
            g_testOffs.erase(g_testOffs.begin() + k);
        } else {
            ++k;
        }
    }

    // Ingest Wi-Fi MIDI (bounded per tick).
    g_midi.poll(nowUs);
    for (auto& e : g_midi.events()) {
        g_web.broadcastMidi(e);
        if (g_phase == AppPhase::Ready) g_instrument.handleEvent(e, nowUs);
    }
    for (auto& sx : g_midi.sysexPackets()) {
        std::vector<uint8_t> resp;
        { StateGuard lock;
          resp = g_sysex.handleMessage(sx.bytes.data(), sx.bytes.size(), nowMs); }
        if (!resp.empty()) g_midi.reply(sx, resp.data(), resp.size());
    }
    g_midi.clear();

    g_instrument.tick(nowUs);   // flush chord groups
    g_servos.update(nowMs);     // scheduled servo returns / rest cut-off

    // Runtime PCA9685 health: a board lost AFTER arming means no finger/pluck can
    // act — panic rather than keep "playing" blind.
    static uint32_t lastPcaCheckMs = 0;
    if (g_phase == AppPhase::Ready && nowMs - lastPcaCheckMs >= 500) {
        lastPcaCheckMs = nowMs;
        if (!g_servos.pcaHealthy()) {
            g_safety.recordFault("servo", "PCA9685 stopped responding on I2C", nowMs);
            doPanic();
        }
    }

    if (g_phase == AppPhase::Ready && g_safety.actuatorsAllowed()) {
        for (size_t i = 0; i < g_instrument.stringCount(); ++i) {
            if (!(i < g_stringFaulted.size() && g_stringFaulted[i]))
                tickString(i, nowMs);
        }
    }

    static uint32_t lastStatusMs = 0;
    if (nowMs - lastStatusMs >= 100) {
        lastStatusMs = nowMs;
        g_web.refreshStatus();
        g_web.broadcastStatus();
    }
}

#endif  // ARDUINO
