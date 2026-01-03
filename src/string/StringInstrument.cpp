#include "StringInstrument.h"

StringInstrument::StringInstrument() {
  config = nullptr;
  currentFret = -1;
  currentMidiNote = 0;
  isPlaying = false;
  lastActivity = 0;
}

void StringInstrument::init(StringConfig* cfg, PCA9685Manager* pcaManager) {
  config = cfg;

  #ifdef DEBUG
  Serial.print("StringInstrument init - MIDI base note: ");
  Serial.println(cfg->baseMidiNote);
  #endif

  // Initialiser les contrôleurs
  fretController.init(cfg, pcaManager);
  pluckController.init(cfg, pcaManager);

  // État initial
  currentFret = -1;
  currentMidiNote = 0;
  isPlaying = false;
  lastActivity = millis();
}

bool StringInstrument::playNote(uint8_t midiNote, uint8_t velocity) {
  if (config == nullptr) {
    return false;
  }

  // Vérifier que cette corde peut jouer cette note
  if (!canPlayNote(midiNote)) {
    #ifdef DEBUG
    Serial.print("ERROR: String cannot play MIDI note ");
    Serial.println(midiNote);
    #endif
    return false;
  }

  // Calculer la frette
  int8_t fret = midiNote - config->baseMidiNote;

  #ifdef DEBUG
  Serial.print("Play note ");
  Serial.print(midiNote);
  Serial.print(" → fret ");
  Serial.print(fret);
  Serial.print(", velocity ");
  Serial.println(velocity);
  #endif

  // Si une autre note est déjà jouée sur cette corde
  if (isPlaying && currentFret != fret) {
    #ifdef LEGATO_MODE
    // Mode legato: changer de frette sans re-gratter
    if (currentFret >= 0) {
      fretController.releaseFret(currentFret);
    }
    if (fret > 0) {
      fretController.pressFret(fret);
      delay(FRET_STABILIZATION_DELAY);
    }
    // Ne pas re-gratter en mode legato
    #else
    // Mode normal: relâcher tout et recommencer
    stopNote(false);
    delay(10);
    #endif
  }

  // Presser la frette si nécessaire (frette 0 = corde à vide)
  if (fret > 0) {
    if (!fretController.pressFret(fret)) {
      return false;
    }
    delay(FRET_STABILIZATION_DELAY);
  }

  // Gratter la corde
  #ifndef LEGATO_MODE
  #ifdef VELOCITY_SENSITIVE
  if (!pluckController.pluck(velocity)) {
    return false;
  }
  #else
  if (!pluckController.pluck()) {
    return false;
  }
  #endif
  #endif

  // Mettre à jour l'état
  currentFret = fret;
  currentMidiNote = midiNote;
  isPlaying = true;
  lastActivity = millis();

  return true;
}

bool StringInstrument::stopNote(bool mute) {
  if (config == nullptr) {
    return false;
  }

  #ifdef DEBUG
  Serial.print("Stop note ");
  Serial.print(currentMidiNote);
  Serial.print(" (mute: ");
  Serial.print(mute ? "yes" : "no");
  Serial.println(")");
  #endif

  // Étouffer ou retourner au centre
  if (mute) {
    #ifdef AUTO_MUTE
    pluckController.mute();
    delay(50);
    #endif
  } else {
    pluckController.returnToCenter();
  }

  // Relâcher toutes les frettes
  fretController.releaseAll();

  // Mettre à jour l'état
  currentFret = -1;
  currentMidiNote = 0;
  isPlaying = false;
  lastActivity = millis();

  return true;
}

bool StringInstrument::canPlayNote(uint8_t midiNote) {
  if (config == nullptr) {
    return false;
  }

  // Vérifier que la note est dans la portée de cette corde
  if (midiNote < config->baseMidiNote) {
    return false;
  }

  if (midiNote > config->baseMidiNote + config->numFrets) {
    return false;
  }

  return true;
}
