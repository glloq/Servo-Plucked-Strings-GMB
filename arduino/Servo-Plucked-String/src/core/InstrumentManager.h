#ifndef INSTRUMENT_MANAGER_H
#define INSTRUMENT_MANAGER_H

#include <Arduino.h>
#include "PCA9685Manager.h"
#include "../string/StringInstrument.h"
#include "../midi/NoteMapper.h"
#include "../config/string_configs.h"

/**
 * Manages the entire instrument
 * Coordinates strings, power management, and timeouts
 */
class InstrumentManager {
private:
  PCA9685Manager pcaManager;
  StringInstrument strings[NUM_STRINGS];
  bool servoPowerEnabled;
  unsigned long lastActivity;

public:
  InstrumentManager();

  // Initialization
  bool init();

  // Note control
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(uint8_t midiNote);
  bool stopAllNotes();

  // Power management
  void enableServoPower();
  void disableServoPower();

  // Periodic update (call in loop())
  void update();

  // Access
  StringInstrument* getString(uint8_t index);
  PCA9685Manager* getPCAManager() { return &pcaManager; }

  // Debug
  void printStatus();

private:
  // Internal utilities
  void moveAllServosToRestPosition();
  void checkTimeouts();
  int8_t findStringPlayingNote(uint8_t midiNote);
};

#endif
