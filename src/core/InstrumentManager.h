#ifndef INSTRUMENT_MANAGER_H
#define INSTRUMENT_MANAGER_H

#include <Arduino.h>
#include "PCA9685Manager.h"
#include "../string/StringInstrument.h"
#include "../midi/NoteMapper.h"
#include "../config/string_configs.h"

/**
 * Gère l'ensemble de l'instrument
 * Coordonne les cordes, la gestion de l'alimentation et les timeouts
 */
class InstrumentManager {
private:
  PCA9685Manager pcaManager;
  StringInstrument strings[NUM_STRINGS];
  bool servoPowerEnabled;
  unsigned long lastActivity;

public:
  InstrumentManager();

  // Initialisation
  bool init();

  // Contrôle des notes
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(uint8_t midiNote);
  bool stopAllNotes();

  // Gestion de l'alimentation
  void enableServoPower();
  void disableServoPower();

  // Mise à jour périodique (à appeler dans loop())
  void update();

  // Accès
  StringInstrument* getString(uint8_t index);
  PCA9685Manager* getPCAManager() { return &pcaManager; }

  // Debug
  void printStatus();

private:
  // Utilitaires internes
  void moveAllServosToRestPosition();
  void checkTimeouts();
  int8_t findStringPlayingNote(uint8_t midiNote);
};

#endif
