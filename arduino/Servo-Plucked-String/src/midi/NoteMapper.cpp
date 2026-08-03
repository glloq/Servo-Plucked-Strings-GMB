#include "NoteMapper.h"

const char* NoteMapper::noteNames[12] = {
  "C", "C#", "D", "D#", "E", "F",
  "F#", "G", "G#", "A", "A#", "B"
};

NoteMapping NoteMapper::mapNote(uint8_t midiNote) {
  NoteMapping result = {-1, -1, false};
  int8_t bestString = -1;
  int8_t bestFret = 127;  // Start very high

  // Iterate through all strings
  for (int i = 0; i < NUM_STRINGS; i++) {
    const StringConfig& cfg = stringConfigs[i];

    // Is the note within range of this string?
    if (midiNote >= cfg.baseMidiNote &&
        midiNote <= cfg.baseMidiNote + cfg.numFrets) {

      int8_t fret = midiNote - cfg.baseMidiNote;

      // Prefer the lowest fret (lower string)
      // This avoids using high frets when an open string suffices
      if (fret < bestFret) {
        bestString = i;
        bestFret = fret;
      }
    }
  }

  if (bestString != -1) {
    result.stringIndex = bestString;
    result.fretNumber = bestFret;
    result.valid = true;

    #ifdef DEBUG_VERBOSE
    Serial.print(F("MIDI "));
    Serial.print(midiNote);
    Serial.print(F(" ("));
    Serial.print(noteToString(midiNote));
    Serial.print(F(") → String "));
    Serial.print(bestString);
    Serial.print(F(", Fret "));
    Serial.println(bestFret);
    #endif
  } else {
    #ifdef DEBUG
    Serial.print(F("WARNING: MIDI note "));
    Serial.print(midiNote);
    Serial.print(F(" ("));
    Serial.print(noteToString(midiNote));
    Serial.println(F(") out of range"));
    #endif
  }

  return result;
}

const char* NoteMapper::noteToString(uint8_t midiNote) {
  static char buffer[8];

  // Note name (C, C#, D, etc.)
  uint8_t noteIndex = midiNote % 12;
  const char* noteName = noteNames[noteIndex];

  // Octave (C4 = MIDI 60)
  int8_t octave = (midiNote / 12) - 1;

  // Format
  snprintf(buffer, sizeof(buffer), "%s%d", noteName, octave);

  return buffer;
}
