#ifndef FRET_CONTROLLER_H
#define FRET_CONTROLLER_H

#include <Arduino.h>
#include "../core/PCA9685Manager.h"
#include "../config/string_configs.h"

/**
 * Controls fret servomotors for a string
 * Manages open (rest) and closed (activated) positions
 */
class FretController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  int8_t activeFret;            // Currently activated fret (-1 = none)
  bool fretStates[MAX_FRETS];   // State of each fret

public:
  FretController();

  // Initialization
  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Control
  bool pressFret(uint8_t fretNum);
  bool releaseFret(uint8_t fretNum);
  bool releaseAll();

  // State
  int8_t getActiveFret() const { return activeFret; }
  bool isFretPressed(uint8_t fretNum) const;
};

#endif
