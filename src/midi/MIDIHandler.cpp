#include "MIDIHandler.h"

MIDIHandler::MIDIHandler() {
  instrument = nullptr;
}

void MIDIHandler::init(InstrumentManager* inst) {
  instrument = inst;

  #ifdef DEBUG
  Serial.println("Initializing MIDIUSB...");
  Serial.println("MIDIUSB ready - listening on all channels");
  #endif
}

void MIDIHandler::process() {
  // Lire les messages MIDI USB
  midiEventPacket_t event;

  do {
    event = MidiUSB.read();
    if (event.header != 0) {
      processMidiMessage(event);
    }
  } while (event.header != 0);
}

void MIDIHandler::processMidiMessage(midiEventPacket_t event) {
  // Extraire les informations du message
  byte header = event.header;
  byte byte1 = event.byte1;
  byte byte2 = event.byte2;
  byte byte3 = event.byte3;

  // Extraire le type de message et le canal
  byte messageType = byte1 & 0xF0;  // 4 bits hauts
  byte channel = (byte1 & 0x0F) + 1; // 4 bits bas (canal 1-16)

  switch (messageType) {
    case 0x90:  // Note On
      if (byte3 > 0) {
        handleNoteOn(channel, byte2, byte3);
      } else {
        // Velocity 0 = Note Off
        handleNoteOff(channel, byte2, 0);
      }
      break;

    case 0x80:  // Note Off
      handleNoteOff(channel, byte2, byte3);
      break;

    case 0xB0:  // Control Change
      handleControlChange(channel, byte2, byte3);
      break;

    #ifdef DEBUG_VERBOSE
    case 0xC0:  // Program Change
      Serial.print("[MIDI] Program Change - Ch:");
      Serial.print(channel);
      Serial.print(" Program:");
      Serial.println(byte2);
      break;

    case 0xE0:  // Pitch Bend
      Serial.print("[MIDI] Pitch Bend - Ch:");
      Serial.print(channel);
      Serial.print(" Value:");
      Serial.println((byte3 << 7) | byte2);
      break;
    #endif

    default:
      #ifdef DEBUG_VERBOSE
      Serial.print("[MIDI] Unknown message type: 0x");
      Serial.println(messageType, HEX);
      #endif
      break;
  }
}

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
    #ifdef DEBUG
    Serial.println("[MIDI] All Notes Off");
    #endif
    instrument->stopAllNotes();
  }

  // CC #120 = All Sound Off
  if (number == 120) {
    #ifdef DEBUG
    Serial.println("[MIDI] All Sound Off");
    #endif
    instrument->stopAllNotes();
  }

  // Ajouter d'autres Control Changes ici si nécessaire
  // CC #64 = Sustain pedal, etc.
}
