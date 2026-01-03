#include "NoteMapper.h"

const char* NoteMapper::noteNames[12] = {
  "C", "C#", "D", "D#", "E", "F",
  "F#", "G", "G#", "A", "A#", "B"
};

NoteMapping NoteMapper::mapNote(uint8_t midiNote) {
  NoteMapping result = {-1, -1, false};
  int8_t bestString = -1;
  int8_t bestFret = 127;  // Commence très haut

  // Parcourir toutes les cordes
  for (int i = 0; i < NUM_STRINGS; i++) {
    const StringConfig& cfg = stringConfigs[i];

    // La note est-elle dans la portée de cette corde?
    if (midiNote >= cfg.baseMidiNote &&
        midiNote <= cfg.baseMidiNote + cfg.numFrets) {

      int8_t fret = midiNote - cfg.baseMidiNote;

      // Préférer la frette la plus basse (corde plus grave)
      // Cela évite d'utiliser les frettes hautes quand une corde à vide suffit
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
    Serial.print("MIDI ");
    Serial.print(midiNote);
    Serial.print(" (");
    Serial.print(noteToString(midiNote));
    Serial.print(") → String ");
    Serial.print(bestString);
    Serial.print(", Fret ");
    Serial.println(bestFret);
    #endif
  } else {
    #ifdef DEBUG
    Serial.print("WARNING: MIDI note ");
    Serial.print(midiNote);
    Serial.print(" (");
    Serial.print(noteToString(midiNote));
    Serial.println(") out of range");
    #endif
  }

  return result;
}

const char* NoteMapper::noteToString(uint8_t midiNote) {
  static char buffer[8];

  // Nom de la note (C, C#, D, etc.)
  uint8_t noteIndex = midiNote % 12;
  const char* noteName = noteNames[noteIndex];

  // Octave (C4 = MIDI 60)
  int8_t octave = (midiNote / 12) - 1;

  // Formater
  snprintf(buffer, sizeof(buffer), "%s%d", noteName, octave);

  return buffer;
}
