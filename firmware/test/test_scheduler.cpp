// End-to-end PlaybackScheduler tests (audit): MIDI event -> InstrumentController
// -> chord grouping -> per-string FSM -> ServoBank pulses, over simulated time.
// The earlier suites cover the servo maths in isolation; these run the REAL
// mechanical sequences (mute travel+hold, strike engagement vs lift retract,
// chord synchronisation, governed lifts, raise-to-play damping) that the audit
// found untested.
#include "TestFramework.h"

#include "../src/core/configuration/PluckPlan.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/instrument/ActuatorManager.h"
#include "../src/core/instrument/InstrumentController.h"
#include "../src/core/midi/MidiEvent.h"
#include "../src/platform/esp32/PlaybackScheduler.h"
#include "../src/platform/esp32/ServoBank.h"

using namespace gmb;

namespace {

ServoConfig servo(const char* fn, int str, uint16_t rest, uint16_t active,
                  uint16_t travel, uint16_t settle) {
    ServoConfig s;
    s.enabled = true;
    s.function = fn;
    s.stringIndex = static_cast<int8_t>(str);
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = 0;  // outputs are ignored on the host; only timings/pulses matter
    s.pulseMinUs = 500;
    s.pulseMaxUs = 2500;
    s.restUs = rest;
    s.activeUs = active;
    s.travelMs = travel;
    s.settleMs = settle;
    return s;
}

ServoConfig pluckServo(int str) {
    ServoConfig s = servo("pluck", str, 1500, 1720, 90, 20);
    s.activeAltUs = 1280;
    s.alternateDirection = true;
    return s;
}

// The full playback stack, driven millisecond by millisecond exactly like
// loop(): MIDI in -> instrument.tick (chord flush) -> servos.update ->
// scheduler.prepareTick -> per-string scheduler ticks.
struct Rig {
    Profile p;
    InstrumentController instrument;
    ServoBank servos;
    ActuatorManager actuators;
    PlaybackScheduler sched;
    uint32_t nowMs = 1000;
    int faults = 0;

    void begin() {
        instrument.load(p);
        // Same overlay applyProfile() performs: global pluck gesture + raise-to-play
        // lift PWM hold (main.cpp) — the rig must drive the servos the runtime way.
        std::vector<ServoConfig> sv = p.servos;
        for (auto& s : sv) {
            if (s.function == "pluck" || s.function == "strum") {
                s.strokeMs = effectivePluckStrokeMs(p.pluck, s);
                s.minStrikeUs = effectivePluckMinStrikeUs(p.pluck, s);
            }
            if (s.function == "strumLift" && p.pluck.liftEngage == LiftEngage::RaiseToPlay)
                s.disableAtRest = false;
        }
        servos.begin(sv, -1, -1, -1);
        // Arm like SafetySupervisor::arm(): outputs on + every servo commanded to
        // rest, so lastCommandedUs() starts at each servo's rest pulse.
        servos.outputEnable(true);
        servos.moveAllToRest();
        actuators.configure(p.power.maxConcurrentMoves, p.power.maxConcurrentPerBoard,
                            p.power.staggerMs);
        sched.begin(&instrument, &servos, &actuators, &p,
                    [this](size_t, const char*, uint32_t) { ++faults; });
        sched.configure(p.strings.size());
    }

    void step(uint32_t ms = 1) {
        for (uint32_t k = 0; k < ms; ++k) {
            ++nowMs;
            instrument.tick(nowMs * 1000u);
            servos.update(nowMs);
            sched.prepareTick(nowMs);
            for (size_t i = 0; i < instrument.stringCount(); ++i) sched.tick(i, nowMs);
        }
    }

    void noteOn(uint8_t note, uint8_t vel = 100) {
        MidiEvent e;
        e.type = static_cast<uint8_t>(MidiType::NoteOn);
        e.channel = 0; e.data1 = note; e.data2 = vel;
        e.timestampUs = nowMs * 1000u;
        instrument.handleEvent(e, nowMs * 1000u);
    }
    void noteOff(uint8_t note) {
        MidiEvent e;
        e.type = static_cast<uint8_t>(MidiType::NoteOff);
        e.channel = 0; e.data1 = note; e.data2 = 0;
        e.timestampUs = nowMs * 1000u;
        instrument.handleEvent(e, nowMs * 1000u);
    }

    // Step until servo `idx` leaves its rest pulse; returns the absolute ms it
    // moved (0 = never moved within `maxMs`).
    uint32_t stepUntilMoved(int idx, uint16_t restUs, uint32_t maxMs) {
        for (uint32_t k = 0; k < maxMs; ++k) {
            step();
            if (servos.lastCommandedUs(idx) != restUs) return nowMs;
        }
        return 0;
    }
};

Profile oneOpenString() {
    Profile p;
    p.instrument.stringCount = 1;
    p.strings.assign(1, StringConfig{});
    p.strings[0].openNote = 60;
    p.strings[0].maxFret = 0;
    p.servos.push_back(pluckServo(0));  // index 0
    p.power.maxConcurrentMoves = 0;     // governor off unless a test turns it on
    return p;
}

}  // namespace

// --- Note-Off plectrum mute: travel + hold (audit) --------------------------

// The plectrum must REACH the string (travelMs) and then hold muteHoldMs before
// it releases. The old code waited only muteHoldMs, recalling the plectrum
// mid-flight (travel 90 > hold 60: the mute never happened).
TEST(scheduler_plectrum_mute_holds_travel_plus_hold) {
    Rig r;
    r.p = oneOpenString();
    r.p.servos[0].muteUs = 1300;
    r.p.pluck.muteSource = MuteSource::Plectrum;
    r.p.pluck.muteHoldMs = 60;
    r.begin();

    r.noteOn(60);
    uint32_t struck = r.stepUntilMoved(0, 1500, 50);
    CHECK(struck != 0);
    r.step(300);  // let the strike return + the note ring

    r.noteOff(60);
    uint32_t offAt = r.nowMs;
    r.step(2);
    CHECK_EQ((int)r.servos.lastCommandedUs(0), 1300);  // driven to the mute pulse
    // Deep into the travel (old code had already released by +60): still muting.
    while (r.nowMs < offAt + 140) r.step();
    CHECK_EQ((int)r.servos.lastCommandedUs(0), 1300);
    CHECK(r.instrument.string(0).state() == StringState::Damping);
    // travel(90) + hold(60) elapsed: released to rest, string idle.
    while (r.nowMs < offAt + 160) r.step();
    CHECK_EQ((int)r.servos.lastCommandedUs(0), 1500);
    CHECK(r.instrument.string(0).state() == StringState::Idle);
    CHECK_EQ(r.faults, 0);
}

// --- Strike engagement vs lift retract (audit) -------------------------------

// With a global strokeMs LONGER than the plectrum travel, the lift must stay
// engaged for the whole stroke: the old scheduler waited travelMs only and
// retracted the plectrum while the stroke was still engaged.
TEST(scheduler_lift_retracts_after_full_stroke) {
    Rig r;
    r.p = oneOpenString();
    ServoConfig lift = servo("strumLift", 0, 1500, 1700, 40, 10);  // index 1
    r.p.servos.push_back(lift);
    r.p.pluck.strokeMs = 200;  // stroke engagement far beyond travel (90)
    r.begin();

    r.noteOn(60);
    uint32_t liftDown = r.stepUntilMoved(1, 1500, 50);
    CHECK(liftDown != 0);
    uint32_t struck = r.stepUntilMoved(0, 1500, 100);
    CHECK(struck != 0);
    // At strike + 150 (past travel 90, inside stroke 200) the lift MUST still be
    // engaged — the old travel-based wait had already retracted it at +90.
    while (r.nowMs < struck + 150) r.step();
    CHECK_EQ((int)r.servos.lastCommandedUs(1), 1700);
    // After the full stroke the lift retracts.
    while (r.nowMs < struck + 220) r.step();
    CHECK_EQ((int)r.servos.lastCommandedUs(1), 1500);
    CHECK_EQ(r.faults, 0);
}

// --- Chord synchronisation (audit) -------------------------------------------

// An open string and a fretted string hit by the same chord must STRIKE together:
// the open string waits for the fretted one's mechanical preparation instead of
// sounding ~150 ms early (noteExecutionDelayMs stays 0 — the sync is automatic).
TEST(scheduler_chord_lands_together) {
    Rig r;
    r.p.instrument.stringCount = 2;
    r.p.strings.assign(2, StringConfig{});
    r.p.strings[0].openNote = 60; r.p.strings[0].maxFret = 0;
    r.p.strings[1].openNote = 55; r.p.strings[1].maxFret = 1;
    r.p.servos.push_back(pluckServo(0));                    // index 0
    r.p.servos.push_back(pluckServo(1));                    // index 1
    ServoConfig finger = servo("finger", 1, 1500, 1900, 120, 30);  // index 2
    finger.fret = 1;
    r.p.servos.push_back(finger);
    r.p.power.maxConcurrentMoves = 0;
    r.begin();

    uint32_t t0 = r.nowMs;
    r.noteOn(60);   // -> string 0 open
    r.noteOn(56);   // -> string 1 fret 1 (55 + 1)
    uint32_t s0 = 0, s1 = 0;
    for (uint32_t k = 0; k < 400 && (!s0 || !s1); ++k) {
        r.step();
        if (!s0 && r.servos.lastCommandedUs(0) != 1500) s0 = r.nowMs;
        if (!s1 && r.servos.lastCommandedUs(1) != 1500) s1 = r.nowMs;
    }
    CHECK(s0 != 0);
    CHECK(s1 != 0);
    // Both waited for the fretted string's preparation (~press 120 + settle 30).
    CHECK(s0 >= t0 + 140);
    int delta = (int)s0 - (int)s1;
    if (delta < 0) delta = -delta;
    CHECK(delta <= 5);
    CHECK_EQ(r.faults, 0);
}

// The fixed execution delay anchors at the Note On's RECEPTION: the 3 ms spent in
// the chord-grouping buffer no longer adds to the configured latency.
TEST(scheduler_delay_anchors_at_reception_not_flush) {
    Rig r;
    r.p = oneOpenString();
    r.p.midi.noteExecutionDelayMs = 100;
    r.begin();

    uint32_t t0 = r.nowMs;
    r.noteOn(60);
    uint32_t struck = r.stepUntilMoved(0, 1500, 200);
    CHECK(struck != 0);
    CHECK(struck >= t0 + 98);
    CHECK(struck <= t0 + 103);  // flush-anchored would land at ~t0+103+
    CHECK_EQ(r.faults, 0);
}

// --- Lifts go through the activation governor (audit) ------------------------

// Two strum lifts engaging for the same chord must be staggered by the governor
// (they used to bypass it and start together); with enough execution-delay
// headroom the strikes still land together afterwards.
TEST(scheduler_lifts_staggered_by_governor) {
    Rig r;
    r.p.instrument.stringCount = 2;
    r.p.strings.assign(2, StringConfig{});
    r.p.strings[0].openNote = 60; r.p.strings[0].maxFret = 0;
    r.p.strings[1].openNote = 55; r.p.strings[1].maxFret = 0;
    r.p.servos.push_back(pluckServo(0));                          // 0
    r.p.servos.push_back(pluckServo(1));                          // 1
    r.p.servos.push_back(servo("strumLift", 0, 1500, 1700, 40, 10));  // 2
    r.p.servos.push_back(servo("strumLift", 1, 1500, 1700, 40, 10));  // 3
    r.p.power.maxConcurrentMoves = 1;
    r.p.power.staggerMs = 50;
    r.p.midi.noteExecutionDelayMs = 200;  // headroom for the staggered engages
    r.begin();

    r.noteOn(60);
    r.noteOn(55);
    uint32_t l0 = 0, l1 = 0, s0 = 0, s1 = 0;
    for (uint32_t k = 0; k < 500; ++k) {
        r.step();
        if (!l0 && r.servos.lastCommandedUs(2) != 1500) l0 = r.nowMs;
        if (!l1 && r.servos.lastCommandedUs(3) != 1500) l1 = r.nowMs;
        if (!s0 && r.servos.lastCommandedUs(0) != 1500) s0 = r.nowMs;
        if (!s1 && r.servos.lastCommandedUs(1) != 1500) s1 = r.nowMs;
    }
    CHECK(l0 != 0);
    CHECK(l1 != 0);
    uint32_t first = l0 < l1 ? l0 : l1, second = l0 < l1 ? l1 : l0;
    CHECK(second - first >= 50);  // staggered engages, not a simultaneous in-rush
    CHECK(s0 != 0);
    CHECK(s1 != 0);
    int delta = (int)s0 - (int)s1;
    if (delta < 0) delta = -delta;
    CHECK(delta <= 5);            // ...and the chord still lands together
    CHECK_EQ(r.faults, 0);
}

// --- Raise-to-play: the falling lift IS the mute, wait its travel (audit) -----

TEST(scheduler_raise_to_play_waits_lift_travel_before_idle) {
    Rig r;
    r.p = oneOpenString();
    ServoConfig lift = servo("strumLift", 0, 1500, 1700, 80, 10);  // index 1
    r.p.servos.push_back(lift);
    r.p.pluck.liftEngage = LiftEngage::RaiseToPlay;
    r.begin();

    r.noteOn(60);
    uint32_t struck = r.stepUntilMoved(0, 1500, 200);
    CHECK(struck != 0);
    r.step(300);
    // Raise-to-play holds the plectrum lifted for the whole note.
    CHECK_EQ((int)r.servos.lastCommandedUs(1), 1700);

    r.noteOff(60);
    uint32_t offAt = r.nowMs;
    r.step(2);
    CHECK_EQ((int)r.servos.lastCommandedUs(1), 1500);  // released: falls onto the string
    // The string is NOT declared idle before the lift physically landed (80 ms) —
    // the old code reported dampingDone immediately.
    while (r.nowMs < offAt + 70) r.step();
    CHECK(r.instrument.string(0).state() == StringState::Damping);
    while (r.nowMs < offAt + 90) r.step();
    CHECK(r.instrument.string(0).state() == StringState::Idle);
    CHECK_EQ(r.faults, 0);
}
