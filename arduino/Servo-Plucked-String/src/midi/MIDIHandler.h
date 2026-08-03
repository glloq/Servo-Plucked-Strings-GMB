#ifndef MIDI_HANDLER_H
#define MIDI_HANDLER_H

#include <Arduino.h>
#include <MIDIUSB.h>
#include "../core/InstrumentManager.h"

/**
 * Gère la réception et le traitement des messages MIDI via USB
 * Utilise la bibliothèque MIDIUSB pour communication USB native
 */
class MIDIHandler {
private:
  InstrumentManager* instrument;

  // Handlers internes
  void handleNoteOn(byte channel, byte note, byte velocity);
  void handleNoteOff(byte channel, byte note, byte velocity);
  void handleControlChange(byte channel, byte number, byte value);

  // Utilitaires
  void processMidiMessage(midiEventPacket_t event);

public:
  MIDIHandler();

  // Initialisation
  void init(InstrumentManager* inst);

  // Traitement (à appeler dans loop())
  void process();
};

#endif
