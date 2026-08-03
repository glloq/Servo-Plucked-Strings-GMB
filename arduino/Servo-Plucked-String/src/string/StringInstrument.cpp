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
  Serial.print(F("StringInstrument init - MIDI base note: "));
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
    Serial.print(F("ERROR: String cannot play MIDI note "));
    Serial.println(midiNote);
    #endif
    return false;
  }

  // Calculate the fret (0 = open string, 1..numFrets = fretted)
  int8_t fret = midiNote - config->baseMidiNote;

  #ifdef DEBUG
  Serial.print(F("Play note "));
  Serial.print(midiNote);
  Serial.print(F(" → fret "));
  Serial.print(fret);
  Serial.print(F(", velocity "));
  Serial.println(velocity);
  #endif

  // LEGATO_MODE / VELOCITY_SENSITIVE are boolean *values* (true/false), so they
  // must be tested with a runtime `if`, never with `#ifdef` (which only checks
  // whether the macro is defined and would always be true here).
  bool legatoTransition = false;

  // If another note is already playing on this string, handle the transition.
  if (isPlaying && currentFret != fret) {
    if (LEGATO_MODE) {
      // Legato: move the fret without re-plucking (hammer-on / pull-off)
      if (currentFret > 0) {
        fretController.releaseFret(currentFret);
      }
      if (fret > 0) {
        if (!fretController.pressFret(fret)) {
          return false;
        }
        delay(FRET_STABILIZATION_DELAY);
      }
      legatoTransition = true;
    } else {
      // Normal mode: release everything and restart from a clean state
      stopNote(false);
      delay(10);
    }
  }

  // A fresh attack (new note or normal re-attack) presses the fret then plucks.
  // A legato transition already moved the fret above and must not re-pluck.
  if (!legatoTransition) {
    // Press the fret if necessary (fret 0 = open string, nothing to press)
    if (fret > 0) {
      if (!fretController.pressFret(fret)) {
        return false;
      }
      delay(FRET_STABILIZATION_DELAY);
    }

    // Pluck the string (velocity-sensitive amplitude when enabled)
    bool plucked = VELOCITY_SENSITIVE ? pluckController.pluck(velocity)
                                      : pluckController.pluck();
    if (!plucked) {
      return false;
    }
  }

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
  Serial.print(F("Stop note "));
  Serial.print(currentMidiNote);
  Serial.print(F(" (mute: "));
  Serial.print(mute ? "yes" : "no");
  Serial.println(F(")"));
  #endif

  // The caller already applied the AUTO_MUTE policy (see InstrumentManager),
  // so honour the runtime `mute` flag here instead of a `#ifdef`.
  if (mute) {
    pluckController.mute();
    delay(MUTE_DELAY);
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
