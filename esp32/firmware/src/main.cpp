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
    uint32_t executeAtMs = 0;    // earliest time the note may sound (fixed delay)
    bool executeAnchored = false;
    bool fingerPressStarted = false;  // press begun (after a governor permit)
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

    g_servos.begin(g_profile.servos, pinOf("SDA"), pinOf("SCL"), pinOf("SERVO_OE"));
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
    std::vector<uint8_t> msg = g_sysex.notification(0x01);
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
// installation/calibration wizard to press/release one finger at a time.
bool doTestServo(int index, bool active) {
    if (!g_safety.actuatorsAllowed()) return false;
    if (!g_servos.commandable(index)) return false;
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
                ok = doTestServo(c->servoIndex, c->servoActive);
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
            // Note released / cancelled: lift the finger and damp.
            sch.releaseWaitMs = releaseCurrentFinger(i);
            if (sch.liftIndex >= 0) { g_servos.release(sch.liftIndex); sch.liftIndex = -1; }
            sch.liftStarted = false;
            int di = g_servos.damperIndex(static_cast<int>(i));
            if (di >= 0) g_servos.strike(di);
            sch.phase = StringSched::WaitStopped;
            sch.phaseStartMs = nowMs;
        }
        // Declare idle once the finger has lifted.
        if (nowMs - sch.phaseStartMs >= sch.releaseWaitMs) {
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
        sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
        sch.executeAnchored = sc.willArmOnSettle();
        sch.fingerPressStarted = false;
        sch.liftStarted = false;
        sch.strikeIndex = -1;
        sch.commandId = tgt.commandId;
        // Lift the currently-pressed finger and wait for it to travel up before
        // pressing the new fret (never two fingers driving at once on a string).
        sch.releaseWaitMs = releaseCurrentFinger(i);
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
                } else if (sch.fingerIndex < 0) {
                    // Fretted note but this fret has no finger servo (a gap / partial
                    // install). Don't hang: advance the FSM so it still plucks the
                    // open string. The validator warns about this configuration.
                    sc.fingerPressed();
                    sc.settled();
                    sch.phase = StringSched::Ready;
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
                if (!g_servos.press(sch.fingerIndex)) {
                    faultRuntimeAxis(i, "finger servo write failed", nowMs);
                    break;
                }
                g_currentFinger[i] = sch.fingerIndex;
                sch.fingerPressStarted = true;
                sch.phaseStartMs = nowMs;
            }
            if (nowMs - sch.phaseStartMs >= g_servos.travelMs(sch.fingerIndex)) {
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
            }
            break;
        }
        case StringSched::Ready: {
            if (!sch.executeAnchored && sc.pluckArmed()) {
                sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
                sch.executeAnchored = true;
            }
            if (!sc.pluckArmed()) break;
            int pi = perStringStrikeIndex(i);
            // Pre-lower the strum lift DURING the fixed-delay wait so the strike
            // lands AT executeAtMs even with a lift.
            if (pi >= 0 && !sch.liftStarted) {
                int li = g_servos.strumLiftIndex(static_cast<int>(i));
                if (li >= 0) {
                    uint32_t liftMs = g_servos.travelMs(li) + g_servos.engageDelayMs(li);
                    if (static_cast<int32_t>(nowMs - sch.executeAtMs) +
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
            if (static_cast<int32_t>(nowMs - sch.executeAtMs) < 0) break;
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
                g_servos.release(sch.liftIndex);
                sch.liftIndex = -1;
                sch.strikeIndex = -1;
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

    WebContext ctx;
    ctx.profile = &g_profile;
    ctx.instrument = &g_instrument;
    ctx.sysex = &g_sysex;
    ctx.servos = &g_servos;
    ctx.net = &g_net;
    ctx.safety = &g_safety;
    ctx.storage = &g_storage;
    ctx.onPanic = []() { g_panicRequested.store(true); };
    ctx.onTestNote = [](uint8_t channel, uint8_t note, uint8_t vel,
                        uint16_t durationMs) -> uint32_t {
        AppCommand c{CmdType::TestNote};
        c.channel = channel; c.note = note; c.velocity = vel;
        c.durationMs = durationMs;
        return enqueueCommand(c);
    };
    ctx.onTestServo = [](int index, bool active) -> uint32_t {
        AppCommand c{CmdType::TestServo};
        c.servoIndex = static_cast<int16_t>(index);
        c.servoActive = active;
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
