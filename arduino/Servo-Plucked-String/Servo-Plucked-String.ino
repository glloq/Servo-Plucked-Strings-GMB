/**
 * Orchestrion Plucked Strings with Servomotors
 *
 * MIDI control of a plucked string instrument using:
 * - Servomotors for frets (note changes)
 * - Servomotors for string plucking
 * - PCA9685 controllers to drive servos via I2C
 *
 * Modular object-oriented architecture
 * Flexible configuration via configuration files
 */

#include "src/config/settings.h"
#include "src/config/string_configs.h"
#include "src/utils/Debug.h"
#include "src/core/InstrumentManager.h"
#include "src/midi/MIDIHandler.h"

// Global instances
InstrumentManager instrument;
MIDIHandler midiHandler;

void setup() {
  // Initialize debug/serial
  Debug::init();

  Debug::log(F("=== SETUP START ==="));

  // Initialize the instrument
  if (!instrument.init()) {
    Debug::log(F("ERROR: Instrument init failed!"));
    while (1) {
      delay(1000);  // Block on critical error
    }
  }

  // Initialize the MIDI handler
  midiHandler.init(&instrument);

  // Optional startup test
  #ifdef STARTUP_TEST
  performStartupTest();
  #endif

  Debug::log(F("=== SETUP COMPLETE ==="));
  Debug::log(F("Ready to play!"));
  Debug::printMemoryInfo();
}

void loop() {
  // Process MIDI messages
  midiHandler.process();

  // Update instrument (timeouts, etc.)
  instrument.update();

  // Optional serial commands (debug)
  #ifdef DEBUG_SERIAL_COMMANDS
  processSerialCommands();
  #endif
}

#ifdef STARTUP_TEST
/**
 * Optional startup test
 * Plays a test sequence on each string
 */
void performStartupTest() {
  Debug::log(F("=== STARTUP TEST ==="));

  instrument.enableServoPower();
  delay(100);

  // Test each string
  for (int s = 0; s < NUM_STRINGS; s++) {
    Debug::log(F("Testing string"), s);

    // Play the open string
    uint8_t baseNote = stringConfigs[s].baseMidiNote;
    instrument.playNote(baseNote, 80);
    delay(500);
    instrument.stopNote(baseNote);
    delay(300);

    // Play the 5th fret
    if (stringConfigs[s].numFrets >= 5) {
      instrument.playNote(baseNote + 5, 80);
      delay(500);
      instrument.stopNote(baseNote + 5);
      delay(300);
    }
  }

  Debug::log(F("Test complete"));
  delay(1000);
}
#endif

#ifdef DEBUG_SERIAL_COMMANDS
/**
 * Serial interface for testing without MIDI
 * Commands:
 *   p<note>,<vel>  : Play note (e.g. p60,80)
 *   s<note>        : Stop note (e.g. s60)
 *   a              : Stop all notes
 *   i              : Print instrument status
 *   h              : Help
 */
void processSerialCommands() {
  if (!Serial.available()) {
    return;
  }

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd.length() == 0) {
    return;
  }

  char command = cmd.charAt(0);

  switch (command) {
    case 'p': {
      // Play note: p<note>,<velocity>
      int comma = cmd.indexOf(',');
      if (comma > 0) {
        int note = cmd.substring(1, comma).toInt();
        int vel = cmd.substring(comma + 1).toInt();
        Serial.print(F("Playing note "));
        Serial.print(note);
        Serial.print(F(" velocity "));
        Serial.println(vel);
        instrument.playNote(note, vel);
      }
      break;
    }

    case 's': {
      // Stop note: s<note>
      int note = cmd.substring(1).toInt();
      Serial.print(F("Stopping note "));
      Serial.println(note);
      instrument.stopNote(note);
      break;
    }

    case 'a': {
      // Stop all
      Serial.println(F("Stopping all notes"));
      instrument.stopAllNotes();
      break;
    }

    case 'i': {
      // Print status
      instrument.printStatus();
      break;
    }

    case 'h': {
      // Help
      Serial.println(F("=== Commands ==="));
      Serial.println(F("p<note>,<vel> - Play note (ex: p60,80)"));
      Serial.println(F("s<note>       - Stop note (ex: s60)"));
      Serial.println(F("a             - Stop all notes"));
      Serial.println(F("i             - Print instrument status"));
      Serial.println(F("h             - This help"));
      break;
    }

    default:
      Serial.print(F("Unknown command: "));
      Serial.println(cmd);
      Serial.println(F("Type 'h' for help"));
      break;
  }
}
#endif
