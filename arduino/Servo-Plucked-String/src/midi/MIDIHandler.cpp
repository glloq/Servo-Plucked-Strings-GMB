#include "MIDIHandler.h"

MIDIHandler::MIDIHandler() {
  instrument = nullptr;
}

void MIDIHandler::init(InstrumentManager* inst) {
  instrument = inst;

  #ifdef DEBUG
  Serial.println(F("Initializing MIDIUSB..."));
  Serial.println(F("MIDIUSB ready - listening on all channels"));
  #endif
}

void MIDIHandler::process() {
  // Read USB MIDI messages
  midiEventPacket_t event;

  do {
    event = MidiUSB.read();
    if (event.header != 0) {
      processMidiMessage(event);
    }
  } while (event.header != 0);
}

void MIDIHandler::processMidiMessage(midiEventPacket_t event) {
  // Extract message information (event.header carries the USB cable/CIN,
  // which we don't need here: the MIDI status is decoded from byte1)
  byte byte1 = event.byte1;
  byte byte2 = event.byte2;
  byte byte3 = event.byte3;

  // Extract message type and channel
  byte messageType = byte1 & 0xF0;  // 4 high bits
  byte channel = (byte1 & 0x0F) + 1; // 4 low bits (channel 1-16)

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
      Serial.print(F("[MIDI] Program Change - Ch:"));
      Serial.print(channel);
      Serial.print(F(" Program:"));
      Serial.println(byte2);
      break;

    case 0xE0:  // Pitch Bend
      Serial.print(F("[MIDI] Pitch Bend - Ch:"));
      Serial.print(channel);
      Serial.print(F(" Value:"));
      Serial.println((byte3 << 7) | byte2);
      break;
    #endif

    default:
      #ifdef DEBUG_VERBOSE
      Serial.print(F("[MIDI] Unknown message type: 0x"));
      Serial.println(messageType, HEX);
      #endif
      break;
  }
}

void MIDIHandler::handleNoteOn(byte channel, byte note, byte velocity) {
  #ifdef DEBUG
  Serial.print(F("[MIDI] NOTE_ON - Ch:"));
  Serial.print(channel);
  Serial.print(F(" Note:"));
  Serial.print(note);
  Serial.print(F(" ("));
  Serial.print(NoteMapper::noteToString(note));
  Serial.print(F(") Vel:"));
  Serial.println(velocity);
  #endif

  if (instrument == nullptr) {
    return;
  }

  // Play the note
  instrument->playNote(note, velocity);
}

void MIDIHandler::handleNoteOff(byte channel, byte note, byte velocity) {
  #ifdef DEBUG
  Serial.print(F("[MIDI] NOTE_OFF - Ch:"));
  Serial.print(channel);
  Serial.print(F(" Note:"));
  Serial.print(note);
  Serial.print(F(" ("));
  Serial.print(NoteMapper::noteToString(note));
  Serial.println(F(")"));
  #endif

  if (instrument == nullptr) {
    return;
  }

  // Stop the note
  instrument->stopNote(note);
}

void MIDIHandler::handleControlChange(byte channel, byte number, byte value) {
  #ifdef DEBUG_VERBOSE
  Serial.print(F("[MIDI] CC - Ch:"));
  Serial.print(channel);
  Serial.print(F(" CC#:"));
  Serial.print(number);
  Serial.print(F(" Val:"));
  Serial.println(value);
  #endif

  if (instrument == nullptr) {
    return;
  }

  // CC #123 = All Notes Off
  if (number == 123) {
    #ifdef DEBUG
    Serial.println(F("[MIDI] All Notes Off"));
    #endif
    instrument->stopAllNotes();
  }

  // CC #120 = All Sound Off
  if (number == 120) {
    #ifdef DEBUG
    Serial.println(F("[MIDI] All Sound Off"));
    #endif
    instrument->stopAllNotes();
  }

  // Add other Control Changes here if necessary
  // CC #64 = Sustain pedal, etc.
}
