#include "PluckController.h"

PluckController::PluckController() {
  config = nullptr;
  pcaManager = nullptr;
  currentDirection = false;  // Commence par direction A (négative)
}

void PluckController::init(StringConfig* cfg, PCA9685Manager* pca) {
  config = cfg;
  pcaManager = pca;
  currentDirection = false;

  #ifdef DEBUG
  Serial.print("PluckController init - center: ");
  Serial.print(cfg->pluckAngleCenter);
  Serial.print("°, amplitude: ±");
  Serial.print(cfg->pluckAmplitude);
  Serial.println("°");
  #endif

  // Initialiser à la position centrale
  returnToCenter();
}

bool PluckController::pluck() {
  if (config == nullptr || pcaManager == nullptr) {
    #ifdef DEBUG
    Serial.println("ERROR: PluckController not initialized");
    #endif
    return false;
  }

  // Calculer l'angle selon la direction
  uint16_t angle;
  if (currentDirection) {
    // Direction B (positive)
    angle = config->pluckAngleCenter + config->pluckAmplitude;
  } else {
    // Direction A (négative)
    angle = config->pluckAngleCenter - config->pluckAmplitude;
  }

  // Limiter l'angle à 0-180°
  if (angle > 180) {
    angle = 180;
  }

  // Envoyer la commande
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG
  Serial.print("Pluck - angle: ");
  Serial.print(angle);
  Serial.print("° (");
  Serial.print(currentDirection ? "B↑" : "A↓");
  Serial.print(") PCA");
  Serial.print(servo.pcaIndex);
  Serial.print(", pin ");
  Serial.println(servo.pin);
  #endif

  // Alterner pour le prochain grattage
  currentDirection = !currentDirection;

  return true;
}

bool PluckController::pluck(uint8_t velocity) {
  #ifdef VELOCITY_SENSITIVE
  if (config == nullptr || pcaManager == nullptr) {
    return false;
  }

  // Calculer une amplitude dynamique basée sur la vélocité
  // velocity: 0-127 → amplitude: 5-25°
  uint16_t dynamicAmplitude = map(velocity, 0, 127, 5, 25);

  // Calculer l'angle
  uint16_t angle;
  if (currentDirection) {
    angle = config->pluckAngleCenter + dynamicAmplitude;
  } else {
    angle = config->pluckAngleCenter - dynamicAmplitude;
  }

  // Limiter
  if (angle > 180) angle = 180;
  if (angle < 0) angle = 0;

  // Envoyer
  uint16_t pwm = pcaManager->angleToPWM(angle);
  ServoMapping& servo = config->pluckServo;

  if (!pcaManager->setPWM(servo.pcaIndex, servo.pin, pwm)) {
    return false;
  }

  #ifdef DEBUG_VERBOSE
  Serial.print("Pluck velocity ");
  Serial.print(velocity);
  Serial.print(" → amplitude ");
  Serial.print(dynamicAmplitude);
  Serial.print("° → angle ");
  Serial.println(angle);
  #endif

  currentDirection = !currentDirection;
  return true;
  #else
  // Si velocity sensitive désactivé, utiliser pluck() normal
  return pluck();
  #endif
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
  Serial.print("Pluck return to center - angle: ");
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
  Serial.print("Pluck mute - angle: ");
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
