#ifndef STRING_INSTRUMENT_H
#define STRING_INSTRUMENT_H

#include <Arduino.h>
#include "FretController.h"
#include "PluckController.h"
#include "../config/string_configs.h"

/**
 * Représente une corde complète de l'instrument
 * Combine FretController et PluckController
 */
class StringInstrument {
private:
  StringConfig* config;
  FretController fretController;
  PluckController pluckController;

  // État
  int8_t currentFret;           // Frette active (-1 = corde à vide)
  uint8_t currentMidiNote;      // Note MIDI jouée (0 = aucune)
  bool isPlaying;               // Corde en train de jouer?
  unsigned long lastActivity;   // Timestamp dernière action

public:
  StringInstrument();

  // Initialisation
  void init(StringConfig* cfg, PCA9685Manager* pcaManager);

  // Contrôle
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(bool mute);
  bool canPlayNote(uint8_t midiNote);

  // État
  uint8_t getCurrentNote() const { return currentMidiNote; }
  int8_t getCurrentFret() const { return currentFret; }
  bool getIsPlaying() const { return isPlaying; }
  unsigned long getLastActivity() const { return lastActivity; }

  // Accès aux contrôleurs
  FretController* getFretController() { return &fretController; }
  PluckController* getPluckController() { return &pluckController; }
  StringConfig* getConfig() { return config; }
};

#endif
