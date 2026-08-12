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
  for (const auto& w : g_pwmLog)
    if (w.off || w.us != 1000) allRest = false;  // restUs == 1000 for both
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

  std::printf(g_fail ? "\nSERVOBANKCHECK FAILED (%d)\n" : "\nservobankcheck OK\n", g_fail);
  return g_fail ? 1 : 0;
}
