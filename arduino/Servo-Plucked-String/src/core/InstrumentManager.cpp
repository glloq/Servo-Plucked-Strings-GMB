#include "InstrumentManager.h"

InstrumentManager::InstrumentManager() {
  servoPowerEnabled = false;
  lastActivity = 0;
}

bool InstrumentManager::init() {
  #ifdef DEBUG
  Serial.println("=== Instrument Manager Init ===");
  #endif

  // Initialize the PCA9685 manager
  if (!pcaManager.init()) {
    #ifdef DEBUG
    Serial.println("ERROR: PCA9685Manager init failed");
    #endif
    return false;
  }

  // Initialize each string
  for (int i = 0; i < NUM_STRINGS; i++) {
    #ifdef DEBUG
    Serial.print("Init string ");
    Serial.println(i);
    #endif

    strings[i].init((StringConfig*)&stringConfigs[i], &pcaManager);
  }

  // Move all servos to rest position
  moveAllServosToRestPosition();

  lastActivity = millis();

  #ifdef DEBUG
  Serial.println("=== Instrument Ready ===");
  #endif

  return true;
}

bool InstrumentManager::playNote(uint8_t midiNote, uint8_t velocity) {
  // Find which string can play this note
  NoteMapping mapping = NoteMapper::mapNote(midiNote);

  if (!mapping.valid) {
    #ifdef DEBUG
    Serial.print("ERROR: Cannot map MIDI note ");
    Serial.println(midiNote);
    #endif
    return false;
  }

  // Enable servo power if necessary
  if (!servoPowerEnabled) {
    enableServoPower();
    delay(5);
  }

  // Play the note on the appropriate string
  bool result = strings[mapping.stringIndex].playNote(midiNote, velocity);

  if (result) {
    lastActivity = millis();
  }

  return result;
}

bool InstrumentManager::stopNote(uint8_t midiNote) {
  // Find which string is playing this note
  int8_t stringIdx = findStringPlayingNote(midiNote);

  if (stringIdx < 0) {
    #ifdef DEBUG_VERBOSE
    Serial.print("Note ");
    Serial.print(midiNote);
    Serial.println(" not currently playing");
    #endif
    return false;
  }

  // Stop the note
  bool result = strings[stringIdx].stopNote(AUTO_MUTE);

  lastActivity = millis();

  return result;
}

bool InstrumentManager::stopAllNotes() {
  #ifdef DEBUG
  Serial.println("Stop all notes");
  #endif

  for (int i = 0; i < NUM_STRINGS; i++) {
    if (strings[i].getIsPlaying()) {
      strings[i].stopNote(false);
    }
  }

  lastActivity = millis();

  return true;
}

void InstrumentManager::enableServoPower() {
  pcaManager.enablePower();
  servoPowerEnabled = true;
}

void InstrumentManager::disableServoPower() {
  pcaManager.disablePower();
  servoPowerEnabled = false;
}

void InstrumentManager::update() {
  // Check timeouts for power saving
  checkTimeouts();
}

void InstrumentManager::printStatus() {
  Serial.println("=== Instrument Status ===");
  Serial.print("Servo power: ");
  Serial.println(servoPowerEnabled ? "ON" : "OFF");

  for (int i = 0; i < NUM_STRINGS; i++) {
    Serial.print("String ");
    Serial.print(i);
    Serial.print(": ");

    if (strings[i].getIsPlaying()) {
      Serial.print("MIDI ");
      Serial.print(strings[i].getCurrentNote());
      Serial.print(" (");
      Serial.print(NoteMapper::noteToString(strings[i].getCurrentNote()));
      Serial.print(") fret ");
      Serial.println(strings[i].getCurrentFret());
    } else {
      Serial.println("idle");
    }
  }
  Serial.println("========================");
}

StringInstrument* InstrumentManager::getString(uint8_t index) {
  if (index >= NUM_STRINGS) {
    return nullptr;
  }
  return &strings[index];
}

void InstrumentManager::moveAllServosToRestPosition() {
  #ifdef DEBUG
  Serial.println("Moving all servos to rest position...");
  #endif

  enableServoPower();
  delay(10);

  for (int s = 0; s < NUM_STRINGS; s++) {
    StringConfig& cfg = (StringConfig&)stringConfigs[s];

    // Frets → Open position (rest)
    for (int f = 0; f < cfg.numFrets; f++) {
      uint16_t angle = cfg.fretCalibration[f].angleOpen;

      if (cfg.fretReversed[f]) {
        angle = 180 - angle;
      }

      uint16_t pwm = pcaManager.angleToPWM(angle);
      ServoMapping& servo = cfg.fretServos[f];
      pcaManager.setPWM(servo.pcaIndex, servo.pin, pwm);
      delay(5);
    }

    // Pluck → Center position (rest)
    uint16_t pwm = pcaManager.angleToPWM(cfg.pluckAngleCenter);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, pwm);
  }

  delay(500);  // Let the servos position themselves
  disableServoPower();

  #ifdef DEBUG
  Serial.println("All servos at rest position");
  #endif
}

void InstrumentManager::checkTimeouts() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();

  // Check every 500ms
  if (now - lastCheck < 500) {
    return;
  }
  lastCheck = now;

  bool anyActive = false;

  // Iterate through all strings
  for (int i = 0; i < NUM_STRINGS; i++) {
    if (strings[i].getIsPlaying()) {
      unsigned long inactivity = now - strings[i].getLastActivity();

      if (inactivity > SERVO_TIMEOUT) {
        #ifdef DEBUG_VERBOSE
        Serial.print("String ");
        Serial.print(i);
        Serial.println(" timeout - releasing");
        #endif

        // Timeout reached, release
        strings[i].stopNote(false);
      } else {
        anyActive = true;
      }
    }
  }

  // If no active strings, cut power
  if (!anyActive && servoPowerEnabled) {
    #ifdef DEBUG_VERBOSE
    Serial.println("No active strings - disabling servo power");
    #endif
    disableServoPower();
  }
}

int8_t InstrumentManager::findStringPlayingNote(uint8_t midiNote) {
  for (int i = 0; i < NUM_STRINGS; i++) {
    if (strings[i].getIsPlaying() && strings[i].getCurrentNote() == midiNote) {
      return i;
    }
  }
  return -1;
}
