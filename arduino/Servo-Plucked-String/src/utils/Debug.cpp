#include "Debug.h"

void Debug::init() {
  #ifdef DEBUG
  Serial.begin(SERIAL_BAUD);

  // Wait for serial port to be ready
  while (!Serial && millis() < 3000) {
    delay(10);
  }

  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("  Orchestrion Plucked Strings Servos"));
  Serial.println(F("========================================"));
  Serial.println();

  printSystemInfo();
  #endif
}

void Debug::log(const char* message) {
  #ifdef DEBUG
  Serial.print(F("["));
  Serial.print(millis());
  Serial.print(F("ms] "));
  Serial.println(message);
  #endif
}

void Debug::log(const char* message, int value) {
  #ifdef DEBUG
  Serial.print(F("["));
  Serial.print(millis());
  Serial.print(F("ms] "));
  Serial.print(message);
  Serial.print(F(": "));
  Serial.println(value);
  #endif
}

void Debug::log(const __FlashStringHelper* message) {
  #ifdef DEBUG
  Serial.print(F("["));
  Serial.print(millis());
  Serial.print(F("ms] "));
  Serial.println(message);
  #endif
}

void Debug::log(const __FlashStringHelper* message, int value) {
  #ifdef DEBUG
  Serial.print(F("["));
  Serial.print(millis());
  Serial.print(F("ms] "));
  Serial.print(message);
  Serial.print(F(": "));
  Serial.println(value);
  #endif
}

void Debug::printSystemInfo() {
  #ifdef DEBUG
  Serial.println(F("System Information:"));
  Serial.print(F("  Strings: "));
  Serial.println(NUM_STRINGS);
  Serial.print(F("  PCA9685 count: "));
  Serial.println(PCA_COUNT);
  Serial.print(F("  I2C frequency: "));
  Serial.print(I2C_FREQUENCY / 1000);
  Serial.println(F(" kHz"));
  Serial.print(F("  Fret stabilization: "));
  Serial.print(FRET_STABILIZATION_DELAY);
  Serial.println(F(" ms"));
  Serial.println();
  #endif
}

void Debug::printMemoryInfo() {
  #ifdef DEBUG
  // Memory information (platform-specific)
  #if defined(__AVR__)
  extern int __heap_start, *__brkval;
  int v;
  int freeRam = (int) &v - (__brkval == 0 ? (int) &__heap_start : (int) __brkval);
  Serial.print(F("Free RAM: "));
  Serial.print(freeRam);
  Serial.println(F(" bytes"));
  #elif defined(ARDUINO_ARCH_SAMD) || defined(ARDUINO_ARCH_SAM)
  // For ARM (Teensy, etc.)
  extern "C" char* sbrk(int incr);
  int freeRam = (int)sbrk(0);
  Serial.print(F("Heap pointer: "));
  Serial.println(freeRam);
  #else
  Serial.println(F("Memory info not available on this platform"));
  #endif
  #endif
}
