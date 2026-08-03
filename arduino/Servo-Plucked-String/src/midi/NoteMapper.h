#ifndef NOTE_MAPPER_H
#define NOTE_MAPPER_H

#include <Arduino.h>
#include "../config/string_configs.h"

/**
 * Result of MIDI → String/Fret mapping
 */
struct NoteMapping {
  int8_t stringIndex;  // String index (-1 if impossible)
  int8_t fretNumber;   // Fret number (0 = open string)
  bool valid;          // Valid mapping?
};

/**
 * MIDI note → string/fret conversion
 * Strategy: Priority to lowest (bass) string that can play the note
 */
class NoteMapper {
public:
  /**
   * Finds the string and fret for a MIDI note
   * @param midiNote MIDI note (0-127)
   * @return Mapping with stringIndex, fretNumber and valid
   */
  static NoteMapping mapNote(uint8_t midiNote);

  /**
   * Converts a MIDI note to name (e.g. 60 → "C4")
   * @param midiNote MIDI note (0-127)
   * @return Note name
   */
  static const char* noteToString(uint8_t midiNote);

private:
  static const char* noteNames[12];
};

#endif
