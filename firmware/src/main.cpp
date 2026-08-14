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
// finger. An ActuatorManager (wrapping the ServoActivationGovernor) staggers the
// current-hungry finger presses of a chord so the PCA9685 in-rush stays bounded,
// while never throttling a sonic-deadline pluck (together with per-servo
// disableAtRest and the one-finger-per-string release-before-press sequence).
//
// Boot sequence (spec §21.1 / §13, adapted): power-on safe → validate profile →
// park every finger at rest → arm for play.
#if defined(ARDUINO)

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_system.h>  // esp_reset_reason() for diagnostics (P2.19)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include <atomic>
#include <vector>

#include "core/app/AppPhase.h"
#include "core/app/Readiness.h"
#include "core/configuration/Profile.h"
#include "core/configuration/ProfileActivation.h"
#include "core/configuration/PluckPlan.h"
#include "core/configuration/ProfileValidator.h"
#include "core/diagnostics/Diagnostics.h"
#include "core/gmb/GmbSysExService.h"
#include "core/instrument/InstrumentController.h"
#include "core/instrument/ActuatorManager.h"
#include "core/midi/MidiEvent.h"
#include "core/safety/SafetyManager.h"
#include "core/util/Debounce.h"
#include "core/util/HoldButton.h"
#include "core/midi/MidiTransport.h"
#include "platform/esp32/CommandDispatcher.h"
#include "platform/esp32/MidiDinTransport.h"
#include "platform/esp32/MidiUsbTransport.h"
#include "platform/esp32/MidiWifi.h"
#include "platform/esp32/Net.h"
#include "platform/esp32/PlaybackScheduler.h"
#include "platform/esp32/ProfileStorage.h"
#include "platform/esp32/SafetySupervisor.h"
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
ActuatorManager g_actuators;  // P1.6: governs staggerable moves, never deadline strikes
PlaybackScheduler g_scheduler;  // P2.17: the per-string mechanical FSM (was tickString)
SafetySupervisor g_supervisor;  // P2.17: arm/park/hardStop/panic/fault ops (bound in setup)
Net g_net;
MidiWifi g_midi;                 // Wi-Fi UDP transport (spec §8.3, priority 1)
MidiUsbTransport g_usbMidi;      // native USB-MIDI (S3) — P1.7 skeleton, inert until wired
MidiDinTransport g_dinMidi;      // DIN-5/TRS UART — P1.7 functional, inert until a RX pin is bound
// Every MIDI transport feeds the SAME InstrumentController (P1.7). Add BLE here.
MidiTransport* const g_transports[] = {&g_midi, &g_usbMidi, &g_dinMidi};
WebApi g_web;
Diagnostics g_diag;  // runtime telemetry (P2.19)
bool g_pcaHealthy = true;          // last loop-side PCA probe result (for diagnostics)
uint8_t g_pcaFailedBoard = 0xFF;   // board bucket that failed, 0xFF = none

// AppPhase (core/app/AppPhase.h) is the application lifecycle view:
// ConfigSafe : no valid profile — actuators locked, web/net up (P0 boot-safe).
// Boot       : transient power-on safe, before the arming sequence starts.
// Parking    : profile validated, servos travelling to rest — no MIDI/test yet (P0).
// Reconfiguring : an old profile's fingers are lifting before a swap.
// Ready      : armed and playable.
AppPhase g_phase = AppPhase::Boot;
bool g_degraded = false;  // Ready but with one or more strings disabled by a fault

// Two-phase profile activation (owned by ProfileActivation, P2.17): the OLD profile's
// fingers are driven to rest and allowed to lift BEFORE the old servo config is
// destroyed, so a profile that removes/reassigns a finger servo can't leave a finger
// pressed while the new profile arms.
ProfileActivation g_activation;

std::vector<bool> g_stringFaulted;   // runtime fault (servo write error, etc.)

int8_t g_estopPin = -1;
Debouncer g_estopDeb;  // debounced E-stop input (avoids a spurious trip)

// BOOT button (GPIO0) forces the Wi-Fi hotspot (AP + captive portal) on a long
// press, so a wrong station config can never lock the user out. GPIO0 is the
// universal ESP32 dev-board BOOT button — held LOW while pressed (INPUT_PULLUP).
// A ~2 s hold avoids accidental triggers; the switch is live (no reboot).
constexpr uint8_t kBootButtonPin = 0;
constexpr uint32_t kBootHoldMs = 2000;
HoldButton g_bootHold;  // long-press on BOOT -> force hotspot (host-tested, P2.17)

// Pending test-note Note Offs (scheduled by /api/test/note).
struct TestNoteOff { uint8_t channel; uint8_t note; uint32_t atMs; };
std::vector<TestNoteOff> g_testOffs;

// The per-string playback FSM (StringSched + tickString) now lives in
// PlaybackScheduler (g_scheduler), which owns the per-string state (P2.17).

// ---- Web -> loop() command queue (P0: no mechanical state off the main loop) --
// The queue/dispatch/result plumbing lives in CommandDispatcher (P2.17); the command
// HANDLERS (do*) stay here and are injected into drain() below.
CommandDispatcher g_commands;
SemaphoreHandle_t g_stateMutex = nullptr;
SemaphoreHandle_t g_storageMutex = nullptr;
std::atomic<bool> g_panicRequested{false};
std::atomic<bool> g_hotspotRequested{false};  // BOOT button / web -> force AP
bool g_authConfiguredCache = false;

// Thin wrapper: enqueue and feed the queue-depth high-water into diagnostics.
uint32_t enqueueCommand(const AppCommand& in) {
    uint32_t id = g_commands.enqueue(in);
    if (id) g_diag.observeCmdQueueDepth(static_cast<uint32_t>(g_commands.depth()));
    return id;
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

// ---- Device-owned network configuration (audit) -------------------------------
// The Settings modal's mode/SSID/hostname used to live ONLY in the (RAM-activated)
// profile, so a reboot silently reverted them to the startup slot. They are now
// DEVICE state in NVS: stored by POST /api/wifi, overlaid onto whatever profile is
// live so the UI/status show what actually runs, and re-applied on every boot and
// profile activation. Passwords stay write-only in the same namespace (spec §20).
std::atomic<bool> g_wifiApplyRequested{false};  // POST /api/wifi apply:true
std::atomic<bool> g_wifiScanRequested{false};   // GET /api/wifi/scan?start=1
// UDP MIDI source posture (audit 4 P2.3): pending policy change (-1 = none;
// 0 open / 1 lockToFirst / 2 disabled) + pending unlock, applied on the loop.
std::atomic<int> g_midiSourceRequested{-1};
std::atomic<bool> g_midiUnlockRequested{false};
std::string g_wifiScanJson =                    // guarded by g_stateMutex
    "{\"ok\":true,\"scanning\":false,\"networks\":[]}";
uint32_t g_seenScanGeneration = 0;

// Overlay the NVS device network settings (when present) onto a profile's network
// block. Called on boot and on every profile activation, so an activated profile
// can never revert the device's stored network choice.
void overlayDeviceNetwork(Profile& p) {
    Preferences prefs;
    prefs.begin("gmb", true);
    if (prefs.isKey("netmode")) {
        String m = prefs.getString("netmode", "");
        if (m == "station") p.network.mode = NetworkMode::Station;
        else if (m == "accessPoint") p.network.mode = NetworkMode::AccessPoint;
    }
    if (prefs.isKey("netssid")) p.network.ssid = prefs.getString("netssid", "").c_str();
    if (prefs.isKey("netapssid")) {
        String s = prefs.getString("netapssid", "");
        if (s.length() > 0) p.network.apSsid = s.c_str();  // never blank the AP name
    }
    if (prefs.isKey("nethost")) {
        String h = prefs.getString("nethost", "");
        if (h.length() > 0) p.network.hostname = h.c_str();
    }
    prefs.end();
}

// Reallocates the per-string vectors + reinitialises the servo hardware. The
// CALLER must hold g_stateMutex around this (and the g_profile assignment that
// precedes an activation) so a web read never observes the runtime half-rebuilt.
void applyProfile() {
    // Device network settings win over whatever the profile carries (audit): the
    // status/UI then show the configuration that actually runs.
    overlayDeviceNetwork(g_profile);
    g_instrument.load(g_profile);
    g_sysex.rebuild(g_profile);
    g_scheduler.configure(g_profile.strings.size());  // sizes the per-string FSM state
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
    g_servos.begin(servos, pinOf("SDA"), pinOf("SCL"), pinOf("SERVO_OE"),
                   pinOf("SDA2"), pinOf("SCL2"), pinOf("SERVO_OE2"));
    g_actuators.configure(g_profile.power.maxConcurrentMoves,
                          g_profile.power.maxConcurrentPerBoard, g_profile.power.staggerMs);

    // The E-stop pin belongs to the (possibly new) profile.
    g_estopPin = pinOf("ESTOP");
    if (g_estopPin >= 0) pinMode(g_estopPin, INPUT_PULLUP);
    g_estopDeb.configure(3, true);  // idle = HIGH (not pressed, active-low input)
}

// Rebuild the capability snapshot from a runtime copy of the profile that
// excludes every disabled or runtime-faulted string, and update g_degraded.
int rebuildRuntimeCapabilities() {
    StateGuard lock;
    Profile rp = g_profile;  // a copy: the live profile is never mutated here
    Readiness rd = applyRuntimeFaults(rp, g_stringFaulted);  // ready-only view + counts
    g_degraded = rd.degraded;
    g_profile.capabilitiesRevision++;
    rp.capabilitiesRevision = g_profile.capabilitiesRevision;
    g_sysex.rebuild(rp);
    return rd.ready;
}

void notifyCapabilitiesChanged() {
    if (!g_midi.hasLastSender()) return;
    // GMB v2 block 0x11 change flags: bit 1 = INSTRUMENTS_CHANGED (the capability
    // set / string config moved). GMB uses it only as a cue to re-read the
    // handshake and compare the revision, so an approximate flag is fine.
    std::vector<uint8_t> msg = g_sysex.notification(0x02);
    if (!msg.empty()) g_midi.notifyLastSender(msg.data(), msg.size());
}

// Central runtime string-fault path (servo write error, PCA loss on one board…).
// Also the fault callback the PlaybackScheduler uses. Now lives in SafetySupervisor
// (P2.17); this thin wrapper keeps the scheduler's callback + call sites unchanged.
void faultRuntimeAxis(size_t i, const char* reason, uint32_t nowMs) {
    g_supervisor.faultAxis(i, reason, nowMs);
}

bool safetyLocked() { return g_supervisor.locked(); }

// Arming / parking / reset now live in SafetySupervisor (P2.17). These thin wrappers
// keep every call site (setup, command handlers, servicePendingActivation) unchanged.
// arm() only STARTS parking (phase -> Parking); serviceParking() finishes it once the
// mechanical settle has elapsed (Parking -> Ready). No MIDI note or mechanical test can
// run until then — the note engine and doTestServo both require actuatorsAllowed().
bool armInstrument(uint32_t nowMs) { return g_supervisor.arm(nowMs); }
void serviceParking(uint32_t nowMs) { g_supervisor.serviceParking(nowMs); }
bool doReset(uint32_t nowMs) { return g_supervisor.reset(nowMs); }

// Immediate hard stop (E-stop / panic / major fault): cut PCA/OE and direct PWM at once
// with no mechanical wait, cancel all commands, lock the state — never gated on a servo
// movement completing (spec P0 §21.2). The op lives in SafetySupervisor (P2.17); the
// test-note + pending-swap cleanup is the hardStopCleanup callback bound in setup().
void doPanic() { g_supervisor.panic(); }
void doEmergencyStop() { g_supervisor.emergencyStop(); }

// ---- loop-side command handlers (only ever called from drainCommands) --------

// Phase 1 of activation: validate, release the OLD profile's fingers, and defer
// the teardown until they have physically lifted (servicePendingActivation).
bool doActivateProfile(const Profile& p, uint32_t nowMs) {
    if (!ProfileValidator::isActivatable(p)) return false;
    if (safetyLocked()) return false;
    g_instrument.panic();
    g_scheduler.reset();  // clear every string's FSM + pressed-finger state
    g_testOffs.clear();
    g_safety.reset();
    g_phase = AppPhase::Reconfiguring;

    // Controlled park (spec P0 §21): drive every current servo to rest (fingers up)
    // with the outputs kept live before the old config is destroyed, and wait for the
    // slowest to travel + settle. The final power cut happens in phase 2, AFTER the
    // mechanical wait — never before (that is hardStop's job, not a profile change).
    g_servos.outputEnable(true);
    g_servos.moveAllToRest();
    uint32_t wait = g_servos.parkDurationMs();
    g_activation.begin(p, nowMs + wait);  // apply once the controlled park has elapsed
    return true;
}

// Phase 2: once the old fingers have lifted (controlled park complete), cut power,
// tear down, and swap in the new profile.
void servicePendingActivation(uint32_t nowMs) {
    g_activation.service(nowMs, [nowMs](const Profile& p) {
        g_servos.hardStop();  // controlled park done: safe to cut before teardown
        {
            StateGuard lock;
            g_profile = p;
            g_profile.capabilitiesRevision++;
            applyProfile();
        }
        if (!armInstrument(nowMs)) g_phase = AppPhase::Boot;
    });
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
    if (us > 0) return ok(g_servos.moveTo(index, us));
    // Report the REAL write result: the calibration UI used to show "→ contact"
    // as a success even when press()/release() failed (audit 4 P1.5).
    return active ? ok(g_servos.press(index)) : ok(g_servos.release(index));
}

void purgeCommands() { g_commands.purge(); }

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
    if (g_bootHold.update(down, nowMs)) g_hotspotRequested.store(true);  // long-press
    if (g_hotspotRequested.exchange(false)) {
        g_net.forceAccessPoint();
        Serial.println(F("BOOT/web: forced Wi-Fi hotspot (AP + captive portal)"));
    }
}

// Serialize the latest Wi-Fi scan state into the snapshot the web task serves
// (GET /api/wifi/scan reads it under the state lock — never the live vectors).
void refreshWifiScanJson() {
    JsonDocument doc;
    doc["ok"] = true;
    doc["scanning"] = g_net.scanInProgress();
    JsonArray arr = doc["networks"].to<JsonArray>();
    for (const auto& r : g_net.scanResults()) {
        JsonObject o = arr.add<JsonObject>();
        o["ssid"] = r.ssid;
        o["rssi"] = r.rssi;
        o["secure"] = r.secure;
        o["channel"] = r.channel;
    }
    std::string out;
    serializeJson(doc, out);
    StateGuard lock;
    g_wifiScanJson = out;
}

// Scan requests + deferred "apply now" of freshly-stored network settings. Runs on
// the main loop (owner of Net/WiFi): the web handler only stored NVS + set a flag,
// so the async task never touches the radio (same split as the hotspot request).
void serviceWifiRequests(uint32_t nowMs) {
    (void)nowMs;
    if (g_wifiScanRequested.exchange(false)) {
        g_net.startScan();
        refreshWifiScanJson();  // snapshot now says scanning:true
    }
    if (g_net.scanGeneration() != g_seenScanGeneration) {
        g_seenScanGeneration = g_net.scanGeneration();
        refreshWifiScanJson();  // fresh results landed
    }
    if (g_wifiApplyRequested.exchange(false)) {
        Preferences prefs;
        prefs.begin("gmb", true);
        String staPass = prefs.getString("wifipass", "");
        String apPass = prefs.getString("appass", "");
        prefs.end();
        { StateGuard lock; overlayDeviceNetwork(g_profile); }
        // Re-begin reconnects with the new settings; on repeated failure Net falls
        // back to the hotspot exactly like at boot, so the device stays reachable.
        g_net.begin(g_profile.network, staPass.c_str(), apPass.c_str());
        Serial.println(F("[net] applying updated device network settings"));
    }
    // UDP MIDI source posture: policy change / unlock requested by the web task,
    // applied here (the loop owns MidiWifi) — audit 4 P2.3.
    int midiPolicy = g_midiSourceRequested.exchange(-1);
    if (midiPolicy >= 0 && midiPolicy <= 2)
        g_midi.setSourcePolicy(static_cast<UdpSourcePolicy>(midiPolicy));
    if (g_midiUnlockRequested.exchange(false)) g_midi.unlockSource();
}

// Run a bounded batch of queued commands on the main loop. The command HANDLERS live
// here (they touch instrument/servos/safety); CommandDispatcher owns the plumbing and
// records each outcome. Handlers return whether the command succeeded.
void drainCommands(uint32_t nowMs) {
    g_commands.drain(2, [nowMs](const AppCommand& c) -> bool {
        switch (c.type) {
            case CmdType::Panic:          doPanic(); g_commands.purge(); return true;
            case CmdType::Reset:          return doReset(nowMs);
            case CmdType::ActivateProfile: return c.profile && doActivateProfile(*c.profile, nowMs);
            case CmdType::TestNote:
                return doTestNote(c.channel, c.note, c.velocity, c.durationMs, nowMs);
            case CmdType::TestServo:
                return doTestServo(c.servoIndex, c.servoActive, c.servoUs);
        }
        return true;
    });
}

// App phase as the string reported to the web/API (shared by ctx.appState and the
// diagnostics endpoint so the two never diverge).
const char* appStateStr() { return appPhaseName(g_phase, g_degraded); }

// ---- Diagnostics (P2.19) -----------------------------------------------------
const char* resetReasonStr() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON:   return "power-on";
        case ESP_RST_EXT:       return "external";
        case ESP_RST_SW:        return "software";
        case ESP_RST_PANIC:     return "panic";
        case ESP_RST_INT_WDT:   return "int-wdt";
        case ESP_RST_TASK_WDT:  return "task-wdt";
        case ESP_RST_WDT:       return "wdt";
        case ESP_RST_DEEPSLEEP: return "deep-sleep";
        case ESP_RST_BROWNOUT:  return "brownout";
        default:                return "unknown";
    }
}

// Push the component totals (each keeps its own running counter) + the cached PCA
// health into g_diag from the loop side, so the web task only ever reads a snapshot.
void feedDiagnostics() {
    g_diag.setMidiDropped(g_midi.droppedEvents());
    g_diag.setUdpDropped(g_midi.droppedPackets());
    g_diag.setFaults(static_cast<uint32_t>(g_safety.faults().size()));
    g_diag.setServoMoves(g_servos.moveCount());
    g_diag.setGovernorThrottles(g_actuators.throttleCount());
    g_diag.setMoveMix(g_actuators.deadlineMoves(), g_actuators.staggerableGrants());
    g_diag.setPca(g_servos.usesPca(), g_pcaHealthy, g_pcaFailedBoard);
}

// Serialise the current telemetry for GET /api/diagnostics. Reads only the g_diag
// snapshot + always-safe ESP metrics — no live I2C / state from the web task.
std::string buildDiagnosticsJson() {
    const DiagCounters& c = g_diag.counters();
    JsonDocument doc;
    doc["uptimeMs"] = millis();
    doc["resetReason"] = resetReasonStr();
    doc["freeHeap"] = ESP.getFreeHeap();
    doc["minFreeHeap"] = ESP.getMinFreeHeap();
    doc["state"] = appStateStr();
    JsonObject midi = doc["midi"].to<JsonObject>();
    midi["events"] = c.midiEvents;
    midi["droppedEvents"] = c.midiDropped;
    midi["droppedPackets"] = c.udpDropped;
    JsonObject sched = doc["scheduler"].to<JsonObject>();
    sched["maxLatencyUs"] = c.schedulerMaxLatencyUs;
    sched["jitterUs"] = c.schedulerJitterUs;
    sched["meanUs"] = c.schedulerMeanUs;
    doc["cmdQueueHighWater"] = c.cmdQueueHighWater;
    doc["faults"] = c.faults;
    doc["servoMoves"] = c.servoMoves;
    doc["governorThrottles"] = c.governorThrottles;
    // Fretted notes abandoned because no finger servo drives the requested fret
    // (the scheduler's last safety net — it no longer plays the wrong open note).
    doc["notesDroppedNoFinger"] = g_scheduler.droppedNoFingerCount();
    JsonObject mv = doc["moveMix"].to<JsonObject>();  // P1.6 in-rush picture
    mv["deadline"] = c.deadlineMoves;                 // sound strikes (never throttled)
    mv["staggerableGranted"] = c.staggerableGrants;   // positioning starts granted
    mv["staggerableDeferred"] = c.governorThrottles;  // positioning starts deferred
    doc["wifiReconnects"] = c.wifiReconnects;
    JsonObject pca = doc["pca"].to<JsonObject>();
    pca["used"] = c.pcaUsed;
    pca["healthy"] = c.pcaHealthy;
    if (c.pcaFailedBoard != 0xFF)
        pca["failedBoard"] = ServoBank::boardName(c.pcaFailedBoard);
    std::string out;
    serializeJson(doc, out);
    return out;
}

}  // namespace

void setup() {
    Serial.begin(115200);
    Serial.println();
    Serial.printf("[boot] Servo-Plucked-Strings-GMB (reset: %s)\n", resetReasonStr());
    g_safety.boot();  // servos neutralised (spec §21.1)
    // Wire the playback scheduler to its collaborators + the central fault path (P2.17).
    g_scheduler.begin(&g_instrument, &g_servos, &g_actuators, &g_profile, faultRuntimeAxis);
    // A SCHEDULED servo write that fails (the automatic post-strike return) takes
    // the owning string out of service like any other actuator fault; a shared/aux
    // servo failure is logged without a string to isolate (audit 4 P1.5).
    g_servos.onUpdateFault([](int servoIndex, ActuatorResult r) {
        int s = g_servos.stringIndexOf(servoIndex);
        std::string reason = std::string("scheduled servo return failed [") +
                             actuatorResultName(r) + "]";
        if (s >= 0)
            faultRuntimeAxis(static_cast<size_t>(s), reason.c_str(), millis());
        else
            g_safety.recordFault("servo", reason + " on servo " +
                                              std::to_string(servoIndex), millis());
    });

    // Bind the SafetySupervisor to the globals it operates on (P2.17). No state moves:
    // it references the same objects every other reader uses; only the arm/park/stop/
    // fault OPERATIONS live in it now. Must precede the arming below.
    SafetySupervisor::Deps sd;
    sd.safety = &g_safety;
    sd.servos = &g_servos;
    sd.instrument = &g_instrument;
    sd.scheduler = &g_scheduler;
    sd.actuators = &g_actuators;
    sd.phase = &g_phase;
    sd.degraded = &g_degraded;
    sd.stringFaulted = &g_stringFaulted;
    sd.estopPin = &g_estopPin;
    sd.profile = &g_profile;
    sd.rebuildCaps = []() -> int { return rebuildRuntimeCapabilities(); };
    sd.notifyCaps = []() { notifyCapabilitiesChanged(); };
    sd.hardStopCleanup = []() { g_testOffs.clear(); g_activation.cancel(); };
    g_supervisor.bind(sd);

    g_commands.begin(16);  // web->loop command queue + result ring + mutex (P2.17)
    g_stateMutex = xSemaphoreCreateMutex();
    g_storageMutex = xSemaphoreCreateMutex();

    g_storage.begin();
    if (g_storage.degraded()) {
        g_safety.recordFault("storage",
            "LittleFS unmountable — profiles unavailable; POST /api/storage/format "
            "to reformat", millis());
    }
    // Never configure GPIO / I2C / PCA / LEDC from a profile that fails validation.
    // P0 boot-safe: if none loads or it is invalid we do NOT fabricate and arm a
    // default profile — that could drive a real machine's actuators to positions that
    // don't match its wiring. Instead we stay in CONFIG_SAFE with an EMPTY profile
    // (no servos, no actuator pins → nothing is ever driven) and bring up only the
    // network + web UI so the user can build or load a valid profile and arm it
    // explicitly. The Ukulele template stays available in the UI, never auto-applied.
    bool haveValidProfile =
        g_storage.load(g_storage.startupSlot(), g_profile) &&
        ProfileValidator::isActivatable(g_profile);
    if (!haveValidProfile) g_profile = Profile();  // empty ⇒ no actuators configured
    {
        uint64_t mac = ESP.getEfuseMac();
        uint8_t id[5];
        for (int i = 0; i < 5; ++i) id[i] = static_cast<uint8_t>((mac >> (8 * i)) & 0x7F);
        g_sysex.setDeviceId(id);
    }
    { StateGuard lock; applyProfile(); }
    g_sysex.setUseV2(true);

    Serial.printf("[boot] profile: %s\n",
                  haveValidProfile ? g_profile.instrument.name.c_str()
                                   : "none valid -> CONFIG_SAFE (web UI only)");

    Preferences prefs;
    prefs.begin("gmb", true);
    String staPass = prefs.getString("wifipass", "");
    String apPass = prefs.getString("appass", "");
    prefs.end();
    g_net.begin(g_profile.network, staPass.c_str(), apPass.c_str());
    g_midi.begin(5006);
    // Restore the stored UDP MIDI source posture (device state, audit 4 P2.3):
    // 0 open (default) / 1 lockToFirst / 2 disabled.
    {
        Preferences p;
        p.begin("gmb", true);
        int midiSrc = p.getInt("midisrc", 0);
        p.end();
        if (midiSrc >= 0 && midiSrc <= 2)
            g_midi.setSourcePolicy(static_cast<UdpSourcePolicy>(midiSrc));
    }
    g_usbMidi.begin();  // P1.7: inert until wired to native USB-MIDI (no-op elsewhere)
    g_dinMidi.begin(nullptr);  // P1.7: byte->event logic ready; inert until a DIN RX UART is bound here
    pinMode(kBootButtonPin, INPUT_PULLUP);  // BOOT button -> force hotspot (long press)
    g_bootHold.configure(kBootHoldMs);
    Serial.println(F("[boot] hold BOOT (GPIO0) ~2 s to force the Wi-Fi hotspot"));

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
    ctx.commandState = [](uint32_t id) -> std::string { return g_commands.commandState(id); };
    ctx.onFormatStorage = []() -> bool { return g_storage.format(); };
    ctx.lockState = []() { if (g_stateMutex) xSemaphoreTake(g_stateMutex, portMAX_DELAY); };
    ctx.unlockState = []() { if (g_stateMutex) xSemaphoreGive(g_stateMutex); };
    ctx.lockStorage = []() { if (g_storageMutex) xSemaphoreTake(g_storageMutex, portMAX_DELAY); };
    ctx.unlockStorage = []() { if (g_storageMutex) xSemaphoreGive(g_storageMutex); };
    ctx.onSetNetwork = [](const WifiSettings& w) -> bool {
        bool okAll = true;
        {
            Preferences p;
            if (!p.begin("gmb", false)) return false;
            // Every write is CHECKED: a failed NVS put must surface as an HTTP
            // error, not a phantom "stored" (audit 5). Removing an absent key is
            // fine (nothing to erase), so remove() is only a failure when the key
            // exists and still cannot be deleted.
            auto put = [&](const char* k, const std::string& v) {
                if (p.putString(k, String(v.c_str())) == 0 && !v.empty()) okAll = false;
            };
            auto erase = [&](const char* k) {
                if (p.isKey(k) && !p.remove(k)) okAll = false;
            };
            if (w.hasMode) put("netmode", w.station ? "station" : "accessPoint");
            if (w.hasSsid) put("netssid", w.ssid);
            if (w.hasApSsid) put("netapssid", w.apSsid);
            if (w.hasHostname) put("nethost", w.hostname);
            // Passwords: overwrite when provided, ERASE when explicitly cleared
            // (open network / forget) — an empty field still keeps the old secret.
            if (w.clearStationPassword) erase("wifipass");
            else if (w.hasStationPassword) put("wifipass", w.stationPassword);
            if (w.clearApPassword) erase("appass");
            else if (w.hasApPassword) put("appass", w.apPassword);
            p.end();
        }
        if (okAll && w.apply) g_wifiApplyRequested.store(true);  // reconnect on the loop
        return okAll;
    };
    ctx.onWifiScanStart = []() { g_wifiScanRequested.store(true); };
    ctx.wifiScanJson = []() -> std::string {
        StateGuard lock;
        return g_wifiScanJson;
    };
    ctx.onSetMidiSource = [](int policy, bool unlock) -> bool {
        if (policy >= 0 && policy <= 2) {
            Preferences p;
            if (!p.begin("gmb", false)) return false;
            size_t written = p.putInt("midisrc", policy);
            p.end();
            if (written == 0) return false;  // NVS write failed: report, don't apply
            g_midiSourceRequested.store(policy);  // applied on the main loop
        }
        if (unlock) g_midiUnlockRequested.store(true);
        return true;
    };
    ctx.midiSourcePolicy = []() -> std::string {
        return udpSourcePolicyName(g_midi.sourcePolicy());
    };
    ctx.midiSourceLocked = []() -> bool { return g_midi.sourceLocked(); };
    ctx.checkToken = [](const std::string& provided) -> bool {
        Preferences p; p.begin("gmb", true);
        String stored = p.getString("admintoken", ""); p.end();
        if (stored.length() == 0) return true;
        return provided == std::string(stored.c_str());
    };
    ctx.onSetAdminToken = [](const std::string& t) -> bool {
        Preferences p;
        if (!p.begin("gmb", false)) return false;
        size_t written = p.putString("admintoken", String(t.c_str()));
        p.end();
        if (written == 0 && !t.empty()) return false;  // NVS write failed
        g_authConfiguredCache = !t.empty();
        return true;
    };
    { Preferences p; p.begin("gmb", true);
      g_authConfiguredCache = p.getString("admintoken", "").length() > 0; p.end(); }
    ctx.authConfigured = []() -> bool { return g_authConfiguredCache; };
    ctx.appState = []() -> std::string { return appStateStr(); };
    ctx.diagnosticsJson = []() -> std::string { return buildDiagnosticsJson(); };
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

    // No homing: begin the parking sequence and arm — but ONLY when a valid profile
    // was loaded. With no valid profile we latch CONFIG_SAFE: outputs stay disabled,
    // no actuator can be driven and no MIDI reaches the mechanics; the web UI is used
    // to build/load a profile and arm it explicitly (P0 boot-safe).
    if (haveValidProfile) {
        armInstrument(millis());  // -> Parking; loop() finishes it (-> Ready)
    } else {
        g_safety.configSafe();
        g_phase = AppPhase::ConfigSafe;
        g_safety.recordFault("config",
            "no valid profile at boot — CONFIG_SAFE; actuators disabled until a "
            "profile is loaded and armed from the web UI", millis());
    }
    g_web.refreshStatus();
    Serial.printf("[boot] setup complete — state %s\n", appStateStr());
}

void loop() {
    uint32_t nowUs = micros();
    uint32_t nowMs = millis();

    // Scheduler latency / jitter: observe the loop() period (diagnostics, P2.19).
    static uint32_t lastLoopUs = 0;
    if (lastLoopUs != 0) g_diag.observeSchedulerPeriodUs(nowUs - lastLoopUs);
    lastLoopUs = nowUs;

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
    serviceWifiRequests(nowMs);     // scan + deferred network-settings apply (audit)

    if (!panicked) drainCommands(nowMs);
    servicePendingActivation(nowMs);
    serviceParking(nowMs);  // Parking -> Ready once the mechanical settle has elapsed

    // Wi-Fi loss policy (single deliberate behaviour, audit P1.10 — the removed
    // WifiLossBehavior enum was never wired): cancel pending commands and release
    // sounding notes, but STAY ARMED so play resumes the moment the link returns.
    static bool wasConnected = false;
    bool nowConnected = g_net.connected() && !g_net.accessPointActive();
    if (wasConnected && !nowConnected && g_phase == AppPhase::Ready) {
        g_instrument.panic();
        g_safety.recordFault("wifi", "Wi-Fi link lost — pending commands cancelled", nowMs);
    }
    if (!wasConnected && nowConnected) g_diag.addWifiReconnect();  // link-up (diagnostics)
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

    // Ingest MIDI from every transport into the SAME InstrumentController (P1.7).
    // Each event already carries its transport as MidiEvent.source (diagnostics/routing).
    for (MidiTransport* t : g_transports) t->poll(nowUs);
    for (MidiTransport* t : g_transports) {
        g_diag.addMidiEvents(static_cast<uint32_t>(t->events().size()));
        for (auto& e : t->events()) {
            g_web.broadcastMidi(e);
            if (g_phase == AppPhase::Ready) g_instrument.handleEvent(e, nowUs);
        }
    }
    // SysEx carries an IP-addressed reply, so it stays on the concrete UDP transport
    // (USB/DIN replies will be added on their own transports as they land).
    for (auto& sx : g_midi.sysexPackets()) {
        std::vector<uint8_t> resp;
        { StateGuard lock;
          resp = g_sysex.handleMessage(sx.bytes.data(), sx.bytes.size(), nowMs); }
        if (!resp.empty()) g_midi.reply(sx, resp.data(), resp.size());
    }
    for (MidiTransport* t : g_transports) t->clear();

    g_instrument.tick(nowUs);   // flush chord groups
    g_servos.update(nowMs);     // scheduled servo returns / rest cut-off

    // Runtime PCA9685 health (audit P1.5): a board lost AFTER arming is isolated to
    // the strings it drives instead of a blanket panic. We identify the exact board
    // that went silent, fault only its strings (rebuild capabilities -> readyDegraded,
    // MIDI re-allocates onto the survivors), and let faultRuntimeAxis escalate to a
    // real panic only when no operational string remains. A lost board that owns NO
    // string (a shared/aux-only board — a common critical resource) can't be isolated
    // safely, so that stays a global panic (fail-safe).
    static uint32_t lastPcaCheckMs = 0;
    if (g_phase == AppPhase::Ready && nowMs - lastPcaCheckMs >= 500) {
        lastPcaCheckMs = nowMs;
        uint8_t failedBoard = 0xFF;
        bool healthy = g_servos.pcaHealthy(failedBoard);
        g_pcaHealthy = healthy;                                   // cache for diagnostics
        g_pcaFailedBoard = healthy ? 0xFF : failedBoard;
        if (!healthy) {
            std::string where = ServoBank::boardName(failedBoard);
            bool isolated = false;
            for (size_t i = 0; i < g_instrument.stringCount() &&
                               g_phase == AppPhase::Ready; ++i) {
                if (!(i < g_stringFaulted.size() && g_stringFaulted[i]) &&
                    g_servos.stringUsesBoard(static_cast<int>(i), failedBoard)) {
                    faultRuntimeAxis(i, ("PCA9685 lost (" + where + ")").c_str(), nowMs);
                    isolated = true;
                }
            }
            if (!isolated) {
                // No string owns the lost board (shared/aux resource) — fail-safe.
                g_safety.recordFault("servo",
                    "PCA9685 lost on " + where + " (no owning string) — global panic", nowMs);
                doPanic();
            }
        }
    }

    if (g_phase == AppPhase::Ready && g_safety.actuatorsAllowed()) {
        // Chord sync: give targets that arrived together in this pass a COMMON
        // strike deadline covering the slowest string's mechanical preparation,
        // so a chord's strings land together (audit). Must precede the ticks.
        g_scheduler.prepareTick(nowMs);
        for (size_t i = 0; i < g_instrument.stringCount(); ++i) {
            if (!(i < g_stringFaulted.size() && g_stringFaulted[i]))
                g_scheduler.tick(i, nowMs);
        }
    }

    static uint32_t lastStatusMs = 0;
    if (nowMs - lastStatusMs >= 100) {
        lastStatusMs = nowMs;
        feedDiagnostics();  // refresh the telemetry snapshot from the loop side (P2.19)
        g_web.refreshStatus();
        g_web.broadcastStatus();
    }
}

#endif  // ARDUINO
