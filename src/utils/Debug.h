#ifndef DEBUG_H
#define DEBUG_H

#include <Arduino.h>
#include "../config/settings.h"

/**
 * Utilitaires de debug et logging
 */
class Debug {
public:
  // Initialisation du port série
  static void init();

  // Logs avec timestamp
  static void log(const char* message);
  static void log(const char* message, int value);

  // Affichage d'informations système
  static void printSystemInfo();
  static void printMemoryInfo();
};

#endif
