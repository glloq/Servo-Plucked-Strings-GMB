#ifndef PLUCK_CONTROLLER_H
#define PLUCK_CONTROLLER_H

#include <Arduino.h>
#include "../core/PCA9685Manager.h"
#include "../config/string_configs.h"

/**
 * Controls the plucking servomotor
 * Manages alternating oscillation around a center position
 */
class PluckController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  bool currentDirection;  // false = negative (A), true = positive (B)

public:
  PluckController();

  // Initialization
  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Actions
  bool pluck();
  bool pluck(uint8_t velocity);  // With velocity sensitivity
  bool returnToCenter();
  bool mute();
  bool setPosition(uint16_t angle);

  // Utilities
  void alternate() { currentDirection = !currentDirection; }
  bool getDirection() const { return currentDirection; }
};

#endif
