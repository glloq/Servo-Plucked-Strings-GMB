/**
 * Orchestrion Plucked Strings with Servomotors
 *
 * Contrôle MIDI d'un instrument à cordes pincées utilisant:
 * - Servomoteurs pour les frettes (changement de notes)
 * - Servomoteurs pour le grattage des cordes
 * - Contrôleurs PCA9685 pour piloter les servos via I2C
 *
 * Architecture modulaire orientée objet
 * Configuration flexible par fichiers de configuration
 */

#include "config/settings.h"
#include "config/string_configs.h"
#include "utils/Debug.h"
#include "core/InstrumentManager.h"
#include "midi/MIDIHandler.h"

// Instances globales
InstrumentManager instrument;
MIDIHandler midiHandler;

void setup() {
  // Initialiser le debug/serial
  Debug::init();

  Debug::log("=== SETUP START ===");

  // Initialiser l'instrument
  if (!instrument.init()) {
    Debug::log("ERROR: Instrument init failed!");
    while (1) {
      delay(1000);  // Bloquer en cas d'erreur critique
    }
  }

  // Initialiser le handler MIDI
  midiHandler.init(&instrument);

  // Test optionnel au démarrage
  #ifdef STARTUP_TEST
  performStartupTest();
  #endif

  Debug::log("=== SETUP COMPLETE ===");
  Debug::log("Ready to play!");
  Debug::printMemoryInfo();
}

void loop() {
  // Traiter les messages MIDI
  midiHandler.process();

  // Mise à jour de l'instrument (timeouts, etc.)
  instrument.update();

  // Commandes série optionnelles (debug)
  #ifdef DEBUG_SERIAL_COMMANDS
  processSerialCommands();
  #endif
}

#ifdef STARTUP_TEST
/**
 * Test de démarrage optionnel
 * Joue une séquence de test sur chaque corde
 */
void performStartupTest() {
  Debug::log("=== STARTUP TEST ===");

  instrument.enableServoPower();
  delay(100);

  // Tester chaque corde
  for (int s = 0; s < NUM_STRINGS; s++) {
    Debug::log("Testing string", s);

    // Jouer la corde à vide
    uint8_t baseNote = stringConfigs[s].baseMidiNote;
    instrument.playNote(baseNote, 80);
    delay(500);
    instrument.stopNote(baseNote);
    delay(300);

    // Jouer la 5ème frette
    if (stringConfigs[s].numFrets >= 5) {
      instrument.playNote(baseNote + 5, 80);
      delay(500);
      instrument.stopNote(baseNote + 5);
      delay(300);
    }
  }

  Debug::log("Test complete");
  delay(1000);
}
#endif

#ifdef DEBUG_SERIAL_COMMANDS
/**
 * Interface série pour tester sans MIDI
 * Commandes:
 *   p<note>,<vel>  : Play note (ex: p60,80)
 *   s<note>        : Stop note (ex: s60)
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
        Serial.print("Playing note ");
        Serial.print(note);
        Serial.print(" velocity ");
        Serial.println(vel);
        instrument.playNote(note, vel);
      }
      break;
    }

    case 's': {
      // Stop note: s<note>
      int note = cmd.substring(1).toInt();
      Serial.print("Stopping note ");
      Serial.println(note);
      instrument.stopNote(note);
      break;
    }

    case 'a': {
      // Stop all
      Serial.println("Stopping all notes");
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
      Serial.println("=== Commands ===");
      Serial.println("p<note>,<vel> - Play note (ex: p60,80)");
      Serial.println("s<note>       - Stop note (ex: s60)");
      Serial.println("a             - Stop all notes");
      Serial.println("i             - Print instrument status");
      Serial.println("h             - This help");
      break;
    }

    default:
      Serial.print("Unknown command: ");
      Serial.println(cmd);
      Serial.println("Type 'h' for help");
      break;
  }
}
#endif
