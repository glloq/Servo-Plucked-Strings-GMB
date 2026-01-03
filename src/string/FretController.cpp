#include "FretController.h"

FretController::FretController() {
  config = nullptr;
  pcaManager = nullptr;
  activeFret = -1;

  for (int i = 0; i < MAX_FRETS; i++) {
    fretStates[i] = false;
  }
}

void FretController::init(StringConfig* cfg, PCA9685Manager* pca) {
  config = cfg;
  pcaManager = pca;
  activeFret = -1;

  #ifdef DEBUG
  Serial.print("FretController init - ");
  Serial.print(cfg->numFrets);
  Serial.println(" frets");
  #endif

  // Mettre toutes les frettes en position ouverte (repos)
  releaseAll();
}

bool FretController::pressFret(uint8_t fretNum) {
  if (config == nullptr || pcaManager == nullptr) {
    #ifdef DEBUG
    Serial.println("ERROR: FretController not initialized");
    #endif
    return false;
  }

  if (fretNum >= config->numFrets) {
    #ifdef DEBUG
    Serial.print("ERROR: Fret number ");
    Serial.print(fretNum);
    Serial.print(" out of range (max: ");
    Serial.print(config->numFrets - 1);
    Serial.println(")");
    #endif
    return false;
  }

  // Obtenir l'angle de fermeture
  uint16_t angle = config->fretCalibration[fretNum].angleClosed;

  // Appliquer l'inversion si nécessaire
  if (config->fretReversed[fretNum]) {
    angle = 180 - angle;
  }

  // Obtenir le mapping servo
  ServoMapping& servo = config->fretServos[fretNum];

  // Envoyer la commande
  uint16_t pwm = pcaManager->angleToPWM(angle);
  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  // Mettre à jour l'état
  fretStates[fretNum] = true;
  activeFret = fretNum;

  #ifdef DEBUG_VERBOSE
  Serial.print("Press fret ");
  Serial.print(fretNum);
  Serial.print(" - angle: ");
  Serial.print(angle);
  Serial.print("° (PCA");
  Serial.print(servo.pcaIndex);
  Serial.print(", pin ");
  Serial.print(servo.pin);
  Serial.println(")");
  #endif

  return true;
}

bool FretController::releaseFret(uint8_t fretNum) {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  if (fretNum >= config->numFrets) {
    return false;
  }

  // Obtenir l'angle d'ouverture (repos)
  uint16_t angle = config->fretCalibration[fretNum].angleOpen;

  // Appliquer l'inversion si nécessaire
  if (config->fretReversed[fretNum]) {
    angle = 180 - angle;
  }

  // Obtenir le mapping servo
  ServoMapping& servo = config->fretServos[fretNum];

  // Envoyer la commande
  uint16_t pwm = pcaManager->angleToPWM(angle);
  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  // Mettre à jour l'état
  fretStates[fretNum] = false;
  if (activeFret == fretNum) {
    activeFret = -1;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print("Release fret ");
  Serial.print(fretNum);
  Serial.print(" - angle: ");
  Serial.print(angle);
  Serial.println("°");
  #endif

  return true;
}

bool FretController::releaseAll() {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.println("Releasing all frets");
  #endif

  bool allOk = true;
  for (uint8_t f = 0; f < config->numFrets; f++) {
    if (fretStates[f]) {
      if (!releaseFret(f)) {
        allOk = false;
      }
      delay(5);  // Petit délai entre chaque frette
    }
  }

  activeFret = -1;
  return allOk;
}

bool FretController::isFretPressed(uint8_t fretNum) const {
  if (fretNum >= MAX_FRETS) {
    return false;
  }
  return fretStates[fretNum];
}
