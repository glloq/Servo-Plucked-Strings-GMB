#ifndef PLUCK_CONTROLLER_H
#define PLUCK_CONTROLLER_H

#include <Arduino.h>
#include "../core/PCA9685Manager.h"
#include "../config/string_configs.h"

/**
 * Contrôle le servomoteur de grattage
 * Gère l'oscillation alternée autour d'une position centrale
 */
class PluckController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  bool currentDirection;  // false = négatif (A), true = positif (B)

public:
  PluckController();

  // Initialisation
  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Actions
  bool pluck();
  bool pluck(uint8_t velocity);  // Avec sensibilité à la vélocité
  bool returnToCenter();
  bool mute();
  bool setPosition(uint16_t angle);

  // Utilitaires
  void alternate() { currentDirection = !currentDirection; }
  bool getDirection() const { return currentDirection; }
};

#endif
