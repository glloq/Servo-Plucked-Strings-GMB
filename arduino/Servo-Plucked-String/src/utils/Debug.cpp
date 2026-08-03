#include "Debug.h"

void Debug::init() {
  #ifdef DEBUG
  Serial.begin(SERIAL_BAUD);

  // Wait for serial port to be ready
  while (!Serial && millis() < 3000) {
    delay(10);
  }

  Serial.println();
  Serial.println("========================================");
  Serial.println("  Orchestrion Plucked Strings Servos");
  Serial.println("========================================");
  Serial.println();

  printSystemInfo();
  #endif
}

void Debug::log(const char* message) {
  #ifdef DEBUG
  Serial.print("[");
  Serial.print(millis());
  Serial.print("ms] ");
  Serial.println(message);
  #endif
}

void Debug::log(const char* message, int value) {
  #ifdef DEBUG
  Serial.print("[");
  Serial.print(millis());
  Serial.print("ms] ");
  Serial.print(message);
  Serial.print(": ");
  Serial.println(value);
  #endif
}

void Debug::printSystemInfo() {
  #ifdef DEBUG
  Serial.println("System Information:");
  Serial.print("  Strings: ");
  Serial.println(NUM_STRINGS);
  Serial.print("  PCA9685 count: ");
  Serial.println(PCA_COUNT);
  Serial.print("  I2C frequency: ");
  Serial.print(I2C_FREQUENCY / 1000);
  Serial.println(" kHz");
  Serial.print("  Fret stabilization: ");
  Serial.print(FRET_STABILIZATION_DELAY);
  Serial.println(" ms");
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
  Serial.print("Free RAM: ");
  Serial.print(freeRam);
  Serial.println(" bytes");
  #elif defined(ARDUINO_ARCH_SAMD) || defined(ARDUINO_ARCH_SAM)
  // For ARM (Teensy, etc.)
  extern "C" char* sbrk(int incr);
  int freeRam = (int)sbrk(0);
  Serial.print("Heap pointer: ");
  Serial.println(freeRam);
  #else
  Serial.println("Memory info not available on this platform");
  #endif
  #endif
}
