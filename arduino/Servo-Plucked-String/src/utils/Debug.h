#ifndef DEBUG_H
#define DEBUG_H

#include <Arduino.h>
#include "../config/settings.h"

/**
 * Debug and logging utilities
 */
class Debug {
public:
  // Serial port initialization
  static void init();

  // Logs with timestamp.
  // The F() / __FlashStringHelper overloads keep the literal in flash on AVR
  // (e.g. Leonardo), which matters because SRAM is scarce there.
  static void log(const char* message);
  static void log(const char* message, int value);
  static void log(const __FlashStringHelper* message);
  static void log(const __FlashStringHelper* message, int value);

  // System information display
  static void printSystemInfo();
  static void printMemoryInfo();
};

#endif
