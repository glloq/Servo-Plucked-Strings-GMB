#pragma once
// Instrumented PCA9685 driver: every write is logged with the I2C bus it went out
// on (via the TwoWire it was constructed with), its address and channel — so a test
// can prove a bus-1 servo really drives Wire1 and not Wire.
//
// Since the firmware audit, ServoBank converts µs -> ticks itself and calls
// setPWM() so it can CHECK the I2C result (Adafruit's writeMicroseconds() discards
// it). This stub mirrors the real signatures and converts the ticks back, so the
// routing checks keep asserting in microseconds.
#include <cstdint>
#include <string>
#include <vector>

#include "Wire.h"

struct PwmWrite {
  std::string bus;
  uint8_t addr;
  uint8_t channel;
  uint16_t us;
  bool off;
};
inline std::vector<PwmWrite> g_pwmLog;

// Non-zero makes the next setPWM() report an I2C failure, exactly as an unplugged
// board does — the failure path ServoBank must now propagate.
inline uint8_t g_pwmError = 0;

class Adafruit_PWMServoDriver {
  uint8_t addr_;
  TwoWire* wire_;

  static constexpr uint8_t kPrescale = 121;      // 50 Hz @ 25 MHz
  static constexpr uint32_t kOscHz = 25000000;

 public:
  Adafruit_PWMServoDriver(uint8_t a = 0x40) : addr_(a), wire_(&Wire) {}
  Adafruit_PWMServoDriver(uint8_t a, TwoWire& w) : addr_(a), wire_(&w) {}
  bool begin(uint8_t = 0) { return true; }
  void setPWMFreq(float) {}
  uint8_t readPrescale() { return kPrescale; }
  uint32_t getOscillatorFrequency() { return kOscHz; }
  void writeMicroseconds(uint8_t ch, uint16_t us) {
    g_pwmLog.push_back({wire_->id, addr_, ch, us, false});
  }
  uint8_t setPWM(uint8_t ch, uint16_t onTicks, uint16_t offTicks) {
    if (g_pwmError) return g_pwmError;  // injected I2C failure
    // FULL OFF is an OFF count of 4096 (bit 12 -> LEDn_OFF_H[4]), the chip's
    // dedicated "always off" bit. An OFF count of 0 is NOT that: it programs the
    // ON and OFF counters to the same value, which NXP warns against — the old
    // code emitted exactly that and this stub accepted it (audit P1).
    if (offTicks == 4096) {
      g_pwmLog.push_back({wire_->id, addr_, ch, 0, true});
      return 0;
    }
    if (offTicks == 0 && onTicks == 0) {
      // Not a valid neutralisation: log it as a PULSE of 0 µs so a test that
      // expects "full off" fails loudly instead of silently accepting it.
      g_pwmLog.push_back({wire_->id, addr_, ch, 0, false});
      return 0;
    }
    // Same relation ServoBank used to build the ticks, inverted (+ half a tick so
    // the round trip lands back on the exact microsecond).
    uint64_t num = static_cast<uint64_t>(offTicks) * 1000000ull * (kPrescale + 1);
    uint16_t us = static_cast<uint16_t>((num + kOscHz / 2) / kOscHz);
    g_pwmLog.push_back({wire_->id, addr_, ch, us, false});
    return 0;
  }
};
