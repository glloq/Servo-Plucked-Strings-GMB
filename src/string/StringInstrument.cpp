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

  // Initialize controllers
  fretController.init(cfg, pcaManager);
  pluckController.init(cfg, pcaManager);

  // Initial state
  currentFret = -1;
  currentMidiNote = 0;
  isPlaying = false;
  lastActivity = millis();
}

bool StringInstrument::playNote(uint8_t midiNote, uint8_t velocity) {
  if (config == nullptr) {
    return false;
  }

  // Check that this string can play this note
  if (!canPlayNote(midiNote)) {
    #ifdef DEBUG
    Serial.print("ERROR: String cannot play MIDI note ");
    Serial.println(midiNote);
    #endif
    return false;
  }

  // Calculate the fret
  int8_t fret = midiNote - config->baseMidiNote;

  #ifdef DEBUG
  Serial.print("Play note ");
  Serial.print(midiNote);
  Serial.print(" → fret ");
  Serial.print(fret);
  Serial.print(", velocity ");
  Serial.println(velocity);
  #endif

  // If another note is already playing on this string
  if (isPlaying && currentFret != fret) {
    #ifdef LEGATO_MODE
    // Legato mode: change fret without re-plucking
    if (currentFret >= 0) {
      fretController.releaseFret(currentFret);
    }
    if (fret > 0) {
      fretController.pressFret(fret);
      delay(FRET_STABILIZATION_DELAY);
    }
    // Don't re-pluck in legato mode
    #else
    // Normal mode: release everything and restart
    stopNote(false);
    delay(10);
    #endif
  }

  // Press the fret if necessary (fret 0 = open string)
  if (fret > 0) {
    if (!fretController.pressFret(fret)) {
      return false;
    }
    delay(FRET_STABILIZATION_DELAY);
  }

  // Pluck the string
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

  // Update state
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

  // Mute or return to center
  if (mute) {
    #ifdef AUTO_MUTE
    pluckController.mute();
    delay(50);
    #endif
  } else {
    pluckController.returnToCenter();
  }

  // Release all frets
  fretController.releaseAll();

  // Update state
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

  // Check that the note is within range of this string
  if (midiNote < config->baseMidiNote) {
    return false;
  }

  if (midiNote > config->baseMidiNote + config->numFrets) {
    return false;
  }

  return true;
}
