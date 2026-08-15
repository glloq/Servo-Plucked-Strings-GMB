// Runtime routing check for the two-I2C-bus ServoBank: compiles the REAL
// ServoBank.cpp against instrumented Wire / PCA9685 stubs and asserts that a
// bus-0 servo drives Wire and a bus-1 servo drives Wire1 (the second controller),
// at the right address + channel — the "does bus 1 actually reach the hardware"
// proof the host compile-check alone cannot give.
#include <cstdio>
#include <vector>

#include "../../src/platform/esp32/ServoBank.h"

using namespace gmb;

static int g_fail = 0;
#define CHECK(cond, msg)                                              \
  do {                                                               \
    if (!(cond)) { std::printf("  [FAIL] %s\n", msg); ++g_fail; }    \
  } while (0)

static ServoConfig pca(const char* fn, int str, uint8_t bus, uint8_t board, uint8_t ch) {
  ServoConfig s;
  s.enabled = true;
  s.function = fn;
  s.stringIndex = static_cast<int8_t>(str);
  s.source = ServoSource::Pca;
  s.i2cBus = bus;
  s.pcaBoard = board;
  s.channel = ch;
  s.pulseMinUs = 500;
  s.pulseMaxUs = 2500;
  s.restUs = 1000;
  s.activeUs = 1800;
  return s;
}

int main() {
  std::vector<ServoConfig> servos = {
      pca("finger", 0, 0, 0, 3),  // index 0: bus 0, board 0 (0x40), channel 3
      pca("finger", 1, 1, 2, 5),  // index 1: bus 1, board 2 (0x42), channel 5
  };
  ServoBank bank;
  bank.begin(servos, 40, 41, 47, 38, 39, 21);  // bus0 SDA/SCL/OE + bus1 SDA2/SCL2/OE2

  // Each I2C controller came up on its own pins.
  CHECK(Wire.beginCount == 1 && Wire.lastSda == 40 && Wire.lastScl == 41,
        "Wire (bus 0) began on SDA/SCL 40/41");
  CHECK(Wire1.beginCount == 1 && Wire1.lastSda == 38 && Wire1.lastScl == 39,
        "Wire1 (bus 1) began on SDA2/SCL2 38/39");

  // A bus-0 servo drives Wire.
  g_pwmLog.clear();
  bank.toActive(0);
  CHECK(g_pwmLog.size() == 1, "servo 0 produced one write");
  if (!g_pwmLog.empty()) {
    CHECK(g_pwmLog[0].bus == "Wire", "bus-0 servo drives Wire");
    CHECK(g_pwmLog[0].addr == 0x40 && g_pwmLog[0].channel == 3,
          "bus-0 servo -> 0x40 channel 3");
  }

  // A bus-1 servo drives Wire1 — the whole point of the feature.
  g_pwmLog.clear();
  bank.toActive(1);
  CHECK(g_pwmLog.size() == 1, "servo 1 produced one write");
  if (!g_pwmLog.empty()) {
    CHECK(g_pwmLog[0].bus == "Wire1", "bus-1 servo drives Wire1");
    CHECK(g_pwmLog[0].addr == 0x42 && g_pwmLog[0].channel == 5,
          "bus-1 servo -> 0x42 channel 5");
  }

  // --- P0.2/P0.3: controlled-park helpers -----------------------------------
  // moveAllToRest() drives every servo to its REST pulse (fingers up) with outputs
  // kept live — phase 1 of both the arming park and a controlled park.
  g_pwmLog.clear();
  bank.moveAllToRest();
  CHECK(g_pwmLog.size() == 2, "moveAllToRest commands both servos");
  bool allRest = !g_pwmLog.empty();
  // Within one PCA9685 tick of restUs (1000 µs for both). A tick is ~4.9 µs at
  // 50 Hz, and the pulse now travels as ticks (ServoBank converts µs -> ticks
  // itself so it can check setPWM()'s I2C result — Adafruit's writeMicroseconds()
  // discarded it, firmware audit P1), so the stub can only report the quantised
  // value the chip would actually emit.
  for (const auto& w : g_pwmLog)
    if (w.off || w.us < 995 || w.us > 1005) allRest = false;
  CHECK(allRest, "moveAllToRest writes the rest pulse to every servo");

  // parkDurationMs() is the mechanical wait an arming/controlled park must allow:
  // max(travelMs + settleMs) across the ENABLED servos, ignoring disabled ones.
  {
    std::vector<ServoConfig> timed = {
        pca("finger", 0, 0, 0, 0),   // travel 120 + settle 30 = 150 (defaults)
        pca("finger", 1, 0, 0, 1),   // overridden below to 300 + 40 = 340
        pca("finger", 2, 0, 0, 2),   // disabled below — must be ignored
    };
    timed[1].travelMs = 300; timed[1].settleMs = 40;   // slowest -> 340
    timed[2].travelMs = 9000; timed[2].settleMs = 9000;
    timed[2].enabled = false;                          // disabled: excluded
    ServoBank b2;
    b2.begin(timed, 40, 41, 47);
    CHECK(b2.parkDurationMs() == 340, "parkDurationMs = max(travel+settle) of enabled servos");
  }

  // --- P1.4: homogeneous ActuatorResult API ---------------------------------
  // A valid, enabled servo drives Ok; an out-of-range index is InvalidIndex.
  CHECK(bank.press(0) == ActuatorResult::Ok, "press(valid) -> Ok");
  CHECK(bank.release(0) == ActuatorResult::Ok, "release(valid) -> Ok");
  CHECK(bank.strike(0) == ActuatorResult::Ok, "strike(valid) -> Ok");
  CHECK(bank.moveTo(0, 1500) == ActuatorResult::Ok, "moveTo(valid) -> Ok");
  CHECK(bank.press(99) == ActuatorResult::InvalidIndex, "press(oob) -> InvalidIndex");
  CHECK(bank.release(-1) == ActuatorResult::InvalidIndex, "release(oob) -> InvalidIndex");
  // No mute position calibrated (muteUs == 0) -> Disabled, so the caller skips it.
  CHECK(bank.mute(0) == ActuatorResult::Disabled, "mute(no muteUs) -> Disabled");
  // A servo present but disabled in the profile never drives -> Disabled.
  {
    std::vector<ServoConfig> mixed = {pca("finger", 0, 0, 0, 0)};
    mixed[0].enabled = false;
    ServoBank b3;
    b3.begin(mixed, 40, 41, 47);
    CHECK(b3.press(0) == ActuatorResult::Disabled, "press(disabled servo) -> Disabled");
  }

  // --- P1.5: map a lost PCA board to the exact strings it takes down -----------
  // servo 0 -> string 0 on bus 0 / board 0 (bucket 0); servo 1 -> string 1 on
  // bus 1 / board 2 (bucket 10). A degraded mode must isolate only the right one.
  CHECK(bank.stringUsesBoard(0, 0), "string 0 is on board bucket 0");
  CHECK(!bank.stringUsesBoard(0, 10), "string 0 is NOT on board bucket 10");
  CHECK(bank.stringUsesBoard(1, 10), "string 1 is on board bucket 10 (bus1/0x42)");
  CHECK(!bank.stringUsesBoard(1, 0), "string 1 is NOT on board bucket 0");
  CHECK(ServoBank::boardName(0) == "bus 0 / 0x40", "boardName(0) = bus 0 / 0x40");
  CHECK(ServoBank::boardName(10) == "bus 1 / 0x42", "boardName(10) = bus 1 / 0x42");
  CHECK(ServoBank::boardName(0xFF) == "direct-GPIO", "boardName(0xFF) = direct-GPIO");
  uint8_t fb = 0xEE;
  CHECK(bank.pcaHealthy(fb), "healthy stubs report all boards OK");

  // --- Firmware audit P1: a failed I2C write must be REPORTED -----------------
  // This is the defect in its native habitat: the real Adafruit driver's
  // writeMicroseconds() calls setPWM() and discards its return value, so once a
  // board had ACKed at boot every later write looked successful — including with
  // the board unplugged. ServoBank now converts µs -> ticks itself and checks
  // setPWM()'s I2C status, so a dead bus surfaces on the WRITE, not 500 ms later
  // on the next pcaHealthy() probe.
  {
    g_pwmLog.clear();
    g_pwmError = 2;  // Wire.endTransmission() != 0, i.e. NACK / bus error
    CHECK(bank.press(0) == ActuatorResult::BusFault,
          "a failed I2C write reports BusFault instead of Ok");
    CHECK(bank.toRest(0) == ActuatorResult::BusFault, "toRest reports it too");
    CHECK(bank.strike(1) == ActuatorResult::BusFault, "so does a strike");
    g_pwmError = 0;
    // And with the bus back, the very same calls succeed again.
    CHECK(bank.press(0) == ActuatorResult::Ok, "recovered bus -> Ok");
  }

  // --- Firmware audit P1: neutralisation uses the chip's real FULL OFF --------
  // setPWM(ch, 0, 0) is not a full-off: it programs the ON and OFF counters to
  // the same value (NXP warns against it) instead of forcing the output off. The
  // full-off bit is LEDn_OFF_H[4], reached with an OFF count of 4096 — which is
  // what Adafruit's own setPin(num, 0) emits. The stub only logs `off` for 4096,
  // so this check fails on the old encoding.
  {
    g_pwmLog.clear();
    ServoBank::ParkResult n = bank.neutralizePcaOutputs();
    CHECK(n.ok, "neutralisation succeeds on a healthy bus");
    CHECK(g_pwmLog.size() == 2, "every enabled PCA channel is silenced");
    bool allFullOff = !g_pwmLog.empty();
    for (const auto& w : g_pwmLog)
      if (!w.off) allFullOff = false;
    CHECK(allFullOff, "each channel gets a real FULL OFF (LEDn_OFF_H[4], 4096)");
  }

  // --- Firmware audit P1: neutralisation is transactional ---------------------
  // A full-off that never reached its board leaves the channel holding its old
  // pulse. The caller must be able to SEE that and keep /OE high instead of
  // releasing the outputs over a live latched command.
  {
    g_pwmError = 2;
    ServoBank::ParkResult n = bank.neutralizePcaOutputs();
    CHECK(!n.ok, "a failed full-off is reported, not swallowed");
    CHECK(n.reason == ActuatorResult::BusFault, "with the I2C reason attached");
    CHECK(n.failedServo >= 0, "and the channel that would not go quiet");
    g_pwmError = 0;
  }

  std::printf(g_fail ? "\nSERVOBANKCHECK FAILED (%d)\n" : "\nservobankcheck OK\n", g_fail);
  return g_fail ? 1 : 0;
}
