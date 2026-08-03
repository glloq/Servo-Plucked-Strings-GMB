#ifndef STRING_INSTRUMENT_H
#define STRING_INSTRUMENT_H

#include <Arduino.h>
#include "FretController.h"
#include "PluckController.h"
#include "../config/string_configs.h"

/**
 * Represents a complete string of the instrument
 * Combines FretController and PluckController
 */
class StringInstrument {
private:
  StringConfig* config;
  FretController fretController;
  PluckController pluckController;

  // State
  int8_t currentFret;           // Active fret (-1 = open string)
  uint8_t currentMidiNote;      // MIDI note being played (0 = none)
  bool isPlaying;               // Is string currently playing?
  unsigned long lastActivity;   // Timestamp of last action

public:
  StringInstrument();

  // Initialization
  void init(StringConfig* cfg, PCA9685Manager* pcaManager);

  // Control
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(bool mute);
  bool canPlayNote(uint8_t midiNote);

  // State
  uint8_t getCurrentNote() const { return currentMidiNote; }
  int8_t getCurrentFret() const { return currentFret; }
  bool getIsPlaying() const { return isPlaying; }
  unsigned long getLastActivity() const { return lastActivity; }

  // Controller access
  FretController* getFretController() { return &fretController; }
  PluckController* getPluckController() { return &pluckController; }
  StringConfig* getConfig() { return config; }
};

#endif
