#pragma once
#include <cstdint>
class TwoWire;
// Mirrors the real Adafruit_PWMServoDriver signatures (v2.4+). setPWM() returns
// uint8_t — 0 when Wire.endTransmission() succeeded, non-zero on an I2C error.
// The old stub declared it `void`, so a compile-check could never have noticed
// that ServoBank was throwing that error code away (firmware audit P1).
class Adafruit_PWMServoDriver {
public:
  Adafruit_PWMServoDriver(uint8_t = 0x40) {}
  Adafruit_PWMServoDriver(uint8_t, TwoWire&) {}   // board bound to a specific I2C bus
  bool begin(uint8_t = 0) { return true; }
  void setPWMFreq(float) {}
  void writeMicroseconds(uint8_t, uint16_t) {}
  uint8_t setPWM(uint8_t, uint16_t, uint16_t) { return 0; }
  uint8_t readPrescale() { return 121; }             // 50 Hz @ 25 MHz
  uint32_t getOscillatorFrequency() { return 25000000; }
};
