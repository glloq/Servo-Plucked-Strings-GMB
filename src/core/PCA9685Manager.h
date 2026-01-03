#ifndef PCA9685_MANAGER_H
#define PCA9685_MANAGER_H

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include "../config/settings.h"

/**
 * Manages communication with PCA9685 controllers
 * Responsible for initialization, PWM control and angle→PWM conversion
 */
class PCA9685Manager {
private:
  Adafruit_PWMServoDriver* controllers[PCA_COUNT];
  bool initialized[PCA_COUNT];

public:
  PCA9685Manager();
  ~PCA9685Manager();

  // Initialization
  bool init();
  bool initController(uint8_t index);

  // PWM Control
  bool setPWM(uint8_t pcaIndex, uint8_t pin, uint16_t value);
  bool setAngle(uint8_t pcaIndex, uint8_t pin, uint16_t angle);

  // Utilities
  uint16_t angleToPWM(uint16_t angle);
  bool isInitialized(uint8_t pcaIndex);

  // Power management
  void enablePower();
  void disablePower();
};

#endif
