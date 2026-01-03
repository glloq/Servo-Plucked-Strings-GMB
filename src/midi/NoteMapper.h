#ifndef NOTE_MAPPER_H
#define NOTE_MAPPER_H

#include <Arduino.h>
#include "../config/string_configs.h"

/**
 * Résultat du mapping MIDI → Corde/Frette
 */
struct NoteMapping {
  int8_t stringIndex;  // Index de la corde (-1 si impossible)
  int8_t fretNumber;   // Numéro de frette (0 = corde à vide)
  bool valid;          // Mapping valide?
};

/**
 * Conversion note MIDI → corde/frette
 * Stratégie: Priorité à la corde la plus basse (grave) pouvant jouer la note
 */
class NoteMapper {
public:
  /**
   * Trouve la corde et la frette pour une note MIDI
   * @param midiNote Note MIDI (0-127)
   * @return Mapping avec stringIndex, fretNumber et valid
   */
  static NoteMapping mapNote(uint8_t midiNote);

  /**
   * Convertit une note MIDI en nom (ex: 60 → "C4")
   * @param midiNote Note MIDI (0-127)
   * @return Nom de la note
   */
  static const char* noteToString(uint8_t midiNote);

private:
  static const char* noteNames[12];
};

#endif
