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
  Serial.print(F("FretController init - "));
  Serial.print(cfg->numFrets);
  Serial.println(F(" frets"));
  #endif

  // Set all frets to open position (rest)
  releaseAll();
}

bool FretController::pressFret(uint8_t fretNum) {
  if (config == nullptr || pcaManager == nullptr) {
    #ifdef DEBUG
    Serial.println(F("ERROR: FretController not initialized"));
    #endif
    return false;
  }

  // Fret 0 is the open string (no servo). Valid pressed frets are 1..numFrets,
  // stored in the config arrays at index fretNum-1 (so numFrets entries map to
  // numFrets frets, and the top note is reachable).
  if (fretNum < 1 || fretNum > config->numFrets) {
    #ifdef DEBUG
    Serial.print(F("ERROR: Fret number "));
    Serial.print(fretNum);
    Serial.print(F(" out of range (1.."));
    Serial.print(config->numFrets);
    Serial.println(F(")"));
    #endif
    return false;
  }

  uint8_t idx = fretNum - 1;

  // Get the closing angle
  uint16_t angle = config->fretCalibration[idx].angleClosed;

  // Apply inversion if necessary
  if (config->fretReversed[idx]) {
    angle = 180 - angle;
  }

  // Get the servo mapping
  ServoMapping& servo = config->fretServos[idx];

  // Send the command
  uint16_t pwm = pcaManager->angleToPWM(angle);
  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  // Update the state
  fretStates[idx] = true;
  activeFret = fretNum;

  #ifdef DEBUG_VERBOSE
  Serial.print(F("Press fret "));
  Serial.print(fretNum);
  Serial.print(F(" - angle: "));
  Serial.print(angle);
  Serial.print(F("° (PCA"));
  Serial.print(servo.pcaIndex);
  Serial.print(F(", pin "));
  Serial.print(servo.pin);
  Serial.println(F(")"));
  #endif

  return true;
}

bool FretController::releaseFret(uint8_t fretNum) {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  if (fretNum < 1 || fretNum > config->numFrets) {
    return false;
  }

  uint8_t idx = fretNum - 1;

  // Get the opening angle (rest)
  uint16_t angle = config->fretCalibration[idx].angleOpen;

  // Apply inversion if necessary
  if (config->fretReversed[idx]) {
    angle = 180 - angle;
  }

  // Get the servo mapping
  ServoMapping& servo = config->fretServos[idx];

  // Send the command
  uint16_t pwm = pcaManager->angleToPWM(angle);
  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  // Update the state
  fretStates[idx] = false;
  if (activeFret == fretNum) {
    activeFret = -1;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print(F("Release fret "));
  Serial.print(fretNum);
  Serial.print(F(" - angle: "));
  Serial.print(angle);
  Serial.println(F("°"));
  #endif

  return true;
}

bool FretController::releaseAll() {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.println(F("Releasing all frets"));
  #endif

  bool allOk = true;
  for (uint8_t idx = 0; idx < config->numFrets; idx++) {
    if (fretStates[idx]) {
      if (!releaseFret(idx + 1)) {  // fret number = array index + 1
        allOk = false;
      }
      delay(5);  // Small delay between each fret
    }
  }

  activeFret = -1;
  return allOk;
}

bool FretController::isFretPressed(uint8_t fretNum) const {
  if (fretNum < 1 || fretNum > MAX_FRETS) {
    return false;
  }
  return fretStates[fretNum - 1];
}
