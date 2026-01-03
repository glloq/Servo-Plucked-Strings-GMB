#ifndef MIDI_HANDLER_H
#define MIDI_HANDLER_H

#include <Arduino.h>
#include <MIDI.h>
#include "../core/InstrumentManager.h"

/**
 * Gère la réception et le traitement des messages MIDI
 */
class MIDIHandler {
private:
  InstrumentManager* instrument;

  // Instance pour les callbacks statiques
  static MIDIHandler* instance;

  // Callbacks MIDI (statiques pour la lib MIDI)
  static void handleNoteOnStatic(byte channel, byte note, byte velocity);
  static void handleNoteOffStatic(byte channel, byte note, byte velocity);
  static void handleControlChangeStatic(byte channel, byte number, byte value);

  // Handlers internes (non-statiques)
  void handleNoteOn(byte channel, byte note, byte velocity);
  void handleNoteOff(byte channel, byte note, byte velocity);
  void handleControlChange(byte channel, byte number, byte value);

public:
  MIDIHandler();

  // Initialisation
  void init(InstrumentManager* inst);

  // Traitement (à appeler dans loop())
  void process();
};

// Instance MIDI globale
extern MIDI_CREATE_DEFAULT_INSTANCE();

#endif
