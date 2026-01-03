#ifndef PCA9685_MANAGER_H
#define PCA9685_MANAGER_H

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include "../config/settings.h"

/**
 * Gère la communication avec les contrôleurs PCA9685
 * Responsable de l'initialisation, contrôle PWM et conversion angle→PWM
 */
class PCA9685Manager {
private:
  Adafruit_PWMServoDriver* controllers[PCA_COUNT];
  bool initialized[PCA_COUNT];

public:
  PCA9685Manager();
  ~PCA9685Manager();

  // Initialisation
  bool init();
  bool initController(uint8_t index);

  // Contrôle PWM
  bool setPWM(uint8_t pcaIndex, uint8_t pin, uint16_t value);
  bool setAngle(uint8_t pcaIndex, uint8_t pin, uint16_t angle);

  // Utilitaires
  uint16_t angleToPWM(uint16_t angle);
  bool isInitialized(uint8_t pcaIndex);

  // Gestion alimentation
  void enablePower();
  void disablePower();
};

#endif
