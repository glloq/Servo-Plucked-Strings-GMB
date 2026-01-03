#include "MIDIHandler.h"

// Instance MIDI
MIDI_CREATE_DEFAULT_INSTANCE();

// Instance statique pour callbacks
MIDIHandler* MIDIHandler::instance = nullptr;

MIDIHandler::MIDIHandler() {
  instrument = nullptr;
  instance = this;  // Enregistrer l'instance pour les callbacks
}

void MIDIHandler::init(InstrumentManager* inst) {
  instrument = inst;

  #ifdef DEBUG
  Serial.println("Initializing MIDI...");
  #endif

  // Initialiser la bibliothèque MIDI
  MIDI.begin(MIDI_CHANNEL_OMNI);  // Écouter tous les canaux

  // Enregistrer les callbacks
  MIDI.setHandleNoteOn(handleNoteOnStatic);
  MIDI.setHandleNoteOff(handleNoteOffStatic);
  MIDI.setHandleControlChange(handleControlChangeStatic);

  #ifdef DEBUG
  Serial.println("MIDI initialized - listening on all channels");
  #endif
}

void MIDIHandler::process() {
  // Lire les messages MIDI
  MIDI.read();
}

// ===== Callbacks statiques =====

void MIDIHandler::handleNoteOnStatic(byte channel, byte note, byte velocity) {
  if (instance != nullptr) {
    instance->handleNoteOn(channel, note, velocity);
  }
}

void MIDIHandler::handleNoteOffStatic(byte channel, byte note, byte velocity) {
  if (instance != nullptr) {
    instance->handleNoteOff(channel, note, velocity);
  }
}

void MIDIHandler::handleControlChangeStatic(byte channel, byte number, byte value) {
  if (instance != nullptr) {
    instance->handleControlChange(channel, number, value);
  }
}

// ===== Handlers internes =====

void MIDIHandler::handleNoteOn(byte channel, byte note, byte velocity) {
  #ifdef DEBUG
  Serial.print("[MIDI] NOTE_ON - Ch:");
  Serial.print(channel);
  Serial.print(" Note:");
  Serial.print(note);
  Serial.print(" (");
  Serial.print(NoteMapper::noteToString(note));
  Serial.print(") Vel:");
  Serial.println(velocity);
  #endif

  if (instrument == nullptr) {
    return;
  }

  // Si velocity = 0, c'est un NOTE_OFF
  if (velocity == 0) {
    handleNoteOff(channel, note, 0);
    return;
  }

  // Jouer la note
  instrument->playNote(note, velocity);
}

void MIDIHandler::handleNoteOff(byte channel, byte note, byte velocity) {
  #ifdef DEBUG
  Serial.print("[MIDI] NOTE_OFF - Ch:");
  Serial.print(channel);
  Serial.print(" Note:");
  Serial.print(note);
  Serial.print(" (");
  Serial.print(NoteMapper::noteToString(note));
  Serial.println(")");
  #endif

  if (instrument == nullptr) {
    return;
  }

  // Arrêter la note
  instrument->stopNote(note);
}

void MIDIHandler::handleControlChange(byte channel, byte number, byte value) {
  #ifdef DEBUG_VERBOSE
  Serial.print("[MIDI] CC - Ch:");
  Serial.print(channel);
  Serial.print(" CC#:");
  Serial.print(number);
  Serial.print(" Val:");
  Serial.println(value);
  #endif

  if (instrument == nullptr) {
    return;
  }

  // CC #123 = All Notes Off
  if (number == 123) {
    instrument->stopAllNotes();
  }

  // Ajouter d'autres Control Changes ici si nécessaire
  // CC #64 = Sustain pedal, etc.
}
