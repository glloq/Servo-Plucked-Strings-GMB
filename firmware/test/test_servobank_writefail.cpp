// Firmware audit P1/P2 — a REFUSED write must not move the software model.
//
// Two defects sat behind these tests:
//
//  P1  ServoBank::writeMicros() called Adafruit's writeMicroseconds(), which
//      calls setPWM() and DISCARDS its return value. Once a board had ACKed at
//      boot, every later write was reported Ok even with the board unplugged:
//      the firmware believed a finger had been pressed and went on to pluck,
//      giving a wrong note, an open string or silence, until the periodic
//      pcaHealthy() probe noticed up to 500 ms later. writePcaMicros() now
//      checks setPWM()'s I2C result and reports BusFault. (The hardware call
//      itself is target-only; the host build exercises the CONTRACT through the
//      write-fault hook, which is the same failure path from writeMicros() down.)
//
//  P2  press/pressFret/release/strike/mute/moveTo updated rt_ (mode, lastUs,
//      strokeParity) BEFORE knowing whether the write landed. lastUs feeds
//      sweepMsToFret(), so a phantom pulse mistimed the NEXT move; a failed
//      release left the bank claiming Rest while the finger was still down; and
//      a failed strike consumed the alternation parity, flipping the direction
//      of the next real stroke.
#include "TestFramework.h"

#include "../src/platform/esp32/ServoBank.h"

using namespace gmb;

namespace {

ServoConfig wfServo(const char* fn, int str) {
    ServoConfig s;
    s.enabled = true;
    s.function = fn;
    s.stringIndex = static_cast<int8_t>(str);
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = static_cast<uint8_t>(str);
    s.pulseMinUs = 500;
    s.pulseMaxUs = 2500;
    s.restUs = 1000;
    s.activeUs = 2000;
    s.travelMs = 100;
    s.settleMs = 20;
    s.disableAtRest = false;  // keep update() from cutting PWM under the tests
    return s;
}

// Refuse every write to `victim`, as a lost PCA9685 would.
std::function<ActuatorResult(int)> refuse(int victim,
                                          ActuatorResult why = ActuatorResult::BusFault) {
    return [victim, why](int i) {
        return i == victim ? why : ActuatorResult::Ok;
    };
}

}  // namespace

TEST(write_failure_is_reported_not_swallowed) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("finger", 0)};
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.press(0)));                    // healthy board: the write lands
    b.hostWriteResult = refuse(0);
    // Every entry point reports the real reason — no more silent success.
    CHECK(b.press(0) == ActuatorResult::BusFault);
    CHECK(b.release(0) == ActuatorResult::BusFault);
    CHECK(b.strike(0) == ActuatorResult::BusFault);
    CHECK(b.moveTo(0, 1700) == ActuatorResult::BusFault);
    CHECK(b.toRest(0) == ActuatorResult::BusFault);
    CHECK(b.toActive(0) == ActuatorResult::BusFault);
}

TEST(a_refused_write_does_not_advance_the_last_commanded_pulse) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("finger", 0)};
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.press(0)));
    CHECK_EQ((int)b.lastCommandedUs(0), 2000);  // really commanded: recorded

    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.release(0)));
    // The servo never received 1000 µs, so the bank must still believe it sits at
    // 2000 — the OLD code recorded the phantom pulse and mistimed the next sweep.
    CHECK_EQ((int)b.lastCommandedUs(0), 2000);

    b.hostWriteResult = nullptr;
    CHECK(ok(b.release(0)));
    CHECK_EQ((int)b.lastCommandedUs(0), 1000);
}

TEST(a_refused_write_does_not_count_as_a_servo_move) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("finger", 0)};
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.press(0)));
    uint32_t moves = b.moveCount();
    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.press(0)));
    CHECK(!ok(b.strike(0)));
    // Diagnostics count pulses that REACHED an output (P2.19), not attempts.
    CHECK_EQ((int)b.moveCount(), (int)moves);
}

TEST(a_refused_release_never_claims_the_finger_lifted) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("finger", 0)};
    sv[0].disableAtRest = true;  // a bogus Rest would cut this servo's PWM
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.press(0)));
    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.release(0)));

    // Still Active as far as the bank is concerned: the finger IS still pressing.
    // update() must therefore NOT walk it through the rest/PWM-cut path.
    b.update(0);
    b.update(1000);  // well past travel + settle
    CHECK_EQ((int)b.lastCommandedUs(0), 2000);  // no phantom rest pulse recorded
}

TEST(a_refused_strike_keeps_the_alternation_parity) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("pluck", 0)};
    sv[0].alternateDirection = true;
    sv[0].restUs = 1500;
    sv[0].activeUs = 1720;     // down-stroke
    sv[0].activeAltUs = 1280;  // up-stroke
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.strike(0)));
    int firstStroke = (int)b.lastCommandedUs(0);   // down-stroke
    CHECK_EQ(firstStroke, 1720);

    // The board drops out for one stroke.
    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.strike(0)));
    b.hostWriteResult = nullptr;

    // The up-stroke that never happened must still be the NEXT one: consuming the
    // parity on a failed write made the plectrum sweep the same way twice.
    CHECK(ok(b.strike(0)));
    CHECK_EQ((int)b.lastCommandedUs(0), 1280);
}

TEST(a_refused_strike_schedules_no_automatic_return) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("pluck", 0)};
    sv[0].strokeMs = 40;
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.strike(0)));
    // Nothing is engaged, so nothing may report itself as striking, and update()
    // must not fire a return write for a stroke that never left the ground.
    CHECK(!b.striking(0));
    b.hostWriteResult = nullptr;
    b.update(0);
    b.update(500);
    CHECK_EQ((int)b.lastCommandedUs(0), 0);  // never written at all
}

TEST(a_refused_press_does_not_mistime_the_next_finger_sweep) {
    ServoBank b;
    // A geared finger: side A at 1900, side B at 1100, neutral 1500. sweepMsToFret
    // scales travelMs by the real pulse distance from where the finger IS.
    ServoConfig g = wfServo("finger", 0);
    g.fret = 1;
    g.fretB = 2;
    g.restUs = 1500;
    g.activeUs = 1900;
    g.activeBUs = 1100;
    g.travelMs = 100;
    std::vector<ServoConfig> sv = {g};
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.pressFret(0, 1)));               // now at side A (1900)
    CHECK_EQ((int)b.lastCommandedUs(0), 1900);
    uint16_t aToB = b.sweepMsToFret(0, 2);      // full A -> B sweep
    CHECK(aToB > 0);

    // A refused press to side B must leave the sweep estimate unchanged: the
    // finger is still at A, so going to B still costs the full sweep. The old
    // code recorded 1100 and then reported ~0 ms for the very move that had not
    // happened, letting the scheduler pluck before the finger arrived.
    b.hostWriteResult = refuse(0);
    CHECK(!ok(b.pressFret(0, 2)));
    b.hostWriteResult = nullptr;
    CHECK_EQ((int)b.sweepMsToFret(0, 2), (int)aToB);
}

TEST(a_refused_mute_does_not_hold_the_plectrum_against_the_string) {
    ServoBank b;
    std::vector<ServoConfig> sv = {wfServo("pluck", 0)};
    sv[0].muteUs = 1450;
    sv[0].disableAtRest = true;
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);

    CHECK(ok(b.release(0)));
    b.hostWriteResult = refuse(0);
    CHECK(b.mute(0) == ActuatorResult::BusFault);
    b.hostWriteResult = nullptr;
    // Still Rest: a bogus Active would have kept this servo's PWM alive forever
    // (moveTo/mute hold deliberately skip the rest-time cut-off).
    CHECK_EQ((int)b.lastCommandedUs(0), 1000);
}
