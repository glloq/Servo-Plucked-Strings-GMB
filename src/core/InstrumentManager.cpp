#include "InstrumentManager.h"

InstrumentManager::InstrumentManager() {
  servoPowerEnabled = false;
  lastActivity = 0;
}

bool InstrumentManager::init() {
  #ifdef DEBUG
  Serial.println("=== Instrument Manager Init ===");
  #endif

  // Initialiser le gestionnaire PCA9685
  if (!pcaManager.init()) {
    #ifdef DEBUG
    Serial.println("ERROR: PCA9685Manager init failed");
    #endif
    return false;
  }

  // Initialiser chaque corde
  for (int i = 0; i < NUM_STRINGS; i++) {
    #ifdef DEBUG
    Serial.print("Init string ");
    Serial.println(i);
    #endif

    strings[i].init((StringConfig*)&stringConfigs[i], &pcaManager);
  }

  // Mettre tous les servos en position de repos
  moveAllServosToRestPosition();

  lastActivity = millis();

  #ifdef DEBUG
  Serial.println("=== Instrument Ready ===");
  #endif

  return true;
}

bool InstrumentManager::playNote(uint8_t midiNote, uint8_t velocity) {
  // Trouver quelle corde peut jouer cette note
  NoteMapping mapping = NoteMapper::mapNote(midiNote);

  if (!mapping.valid) {
    #ifdef DEBUG
    Serial.print("ERROR: Cannot map MIDI note ");
    Serial.println(midiNote);
    #endif
    return false;
  }

  // Activer l'alimentation des servos si nécessaire
  if (!servoPowerEnabled) {
    enableServoPower();
    delay(5);
  }

  // Jouer la note sur la corde appropriée
  bool result = strings[mapping.stringIndex].playNote(midiNote, velocity);

  if (result) {
    lastActivity = millis();
  }

  return result;
}

bool InstrumentManager::stopNote(uint8_t midiNote) {
  // Trouver quelle corde joue cette note
  int8_t stringIdx = findStringPlayingNote(midiNote);

  if (stringIdx < 0) {
    #ifdef DEBUG_VERBOSE
    Serial.print("Note ");
    Serial.print(midiNote);
    Serial.println(" not currently playing");
    #endif
    return false;
  }

  // Arrêter la note
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
  // Vérifier les timeouts pour économie d'énergie
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

    // Frettes → Position ouverte (repos)
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

    // Pluck → Position centrale (repos)
    uint16_t pwm = pcaManager.angleToPWM(cfg.pluckAngleCenter);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, pwm);
  }

  delay(500);  // Laisser les servos se positionner
  disableServoPower();

  #ifdef DEBUG
  Serial.println("All servos at rest position");
  #endif
}

void InstrumentManager::checkTimeouts() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();

  // Vérifier toutes les 500ms
  if (now - lastCheck < 500) {
    return;
  }
  lastCheck = now;

  bool anyActive = false;

  // Parcourir toutes les cordes
  for (int i = 0; i < NUM_STRINGS; i++) {
    if (strings[i].getIsPlaying()) {
      unsigned long inactivity = now - strings[i].getLastActivity();

      if (inactivity > SERVO_TIMEOUT) {
        #ifdef DEBUG_VERBOSE
        Serial.print("String ");
        Serial.print(i);
        Serial.println(" timeout - releasing");
        #endif

        // Timeout atteint, relâcher
        strings[i].stopNote(false);
      } else {
        anyActive = true;
      }
    }
  }

  // Si aucune corde active, couper l'alimentation
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
