#include "PluckController.h"

PluckController::PluckController() {
  config = nullptr;
  pcaManager = nullptr;
  currentDirection = false;  // Start with direction A (negative)
}

void PluckController::init(StringConfig* cfg, PCA9685Manager* pca) {
  config = cfg;
  pcaManager = pca;
  currentDirection = false;

  #ifdef DEBUG
  Serial.print(F("PluckController init - center: "));
  Serial.print(cfg->pluckAngleCenter);
  Serial.print(F("°, amplitude: ±"));
  Serial.print(cfg->pluckAmplitude);
  Serial.println(F("°"));
  #endif

  // Initialize to center position
  returnToCenter();
}

bool PluckController::pluck() {
  if (config == nullptr || pcaManager == nullptr) {
    #ifdef DEBUG
    Serial.println(F("ERROR: PluckController not initialized"));
    #endif
    return false;
  }

  // Calculate angle based on direction
  uint16_t angle;
  if (currentDirection) {
    // Direction B (positive)
    angle = config->pluckAngleCenter + config->pluckAmplitude;
  } else {
    // Direction A (negative)
    angle = config->pluckAngleCenter - config->pluckAmplitude;
  }

  // Limit angle to 0-180°
  if (angle > 180) {
    angle = 180;
  }

  // Send the command
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG
  Serial.print(F("Pluck - angle: "));
  Serial.print(angle);
  Serial.print(F("° ("));
  Serial.print(currentDirection ? "B↑" : "A↓");
  Serial.print(F(") PCA"));
  Serial.print(servo.pcaIndex);
  Serial.print(F(", pin "));
  Serial.println(servo.pin);
  #endif

  // Alternate for next pluck
  currentDirection = !currentDirection;

  return true;
}

bool PluckController::pluck(uint8_t velocity) {
  // Velocity-aware pluck. Whether it is used at all is decided by the caller
  // via the VELOCITY_SENSITIVE runtime flag (see StringInstrument::playNote).
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  // Map velocity (0-127) to a dynamic oscillation amplitude (5-25°)
  uint16_t dynamicAmplitude = map(velocity, 0, 127, 5, 25);

  // Calculate angle around the center, based on the current direction
  uint16_t angle;
  if (currentDirection) {
    angle = config->pluckAngleCenter + dynamicAmplitude;
  } else {
    angle = config->pluckAngleCenter - dynamicAmplitude;
  }

  // Limit angle to 0-180° (uint16_t can't be negative, only clamp the top)
  if (angle > 180) {
    angle = 180;
  }

  // Send the command
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print(F("Pluck velocity "));
  Serial.print(velocity);
  Serial.print(F(" → amplitude "));
  Serial.print(dynamicAmplitude);
  Serial.print(F("° → angle "));
  Serial.println(angle);
  #endif

  // Alternate for next pluck
  currentDirection = !currentDirection;
  return true;
}

bool PluckController::returnToCenter() {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  uint16_t angle = config->pluckAngleCenter;
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print(F("Pluck return to center - angle: "));
  Serial.println(angle);
  #endif

  return true;
}

bool PluckController::mute() {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  uint16_t angle = config->pluckMuteAngle;
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print(F("Pluck mute - angle: "));
  Serial.println(angle);
  #endif

  return true;
}

bool PluckController::setPosition(uint16_t angle) {
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  if (angle > 180) {
    angle = 180;
  }

  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  return pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm);
}
