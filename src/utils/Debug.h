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

  // Logs with timestamp
  static void log(const char* message);
  static void log(const char* message, int value);

  // System information display
  static void printSystemInfo();
  static void printMemoryInfo();
};

#endif
