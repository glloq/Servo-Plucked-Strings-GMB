#ifndef FRET_CONTROLLER_H
#define FRET_CONTROLLER_H

#include <Arduino.h>
#include "../core/PCA9685Manager.h"
#include "../config/string_configs.h"

/**
 * Contrôle les servomoteurs de frettes pour une corde
 * Gère les positions ouverte (repos) et fermée (activée)
 */
class FretController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  int8_t activeFret;            // Frette actuellement activée (-1 = aucune)
  bool fretStates[MAX_FRETS];   // État de chaque frette

public:
  FretController();

  // Initialisation
  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Contrôle
  bool pressFret(uint8_t fretNum);
  bool releaseFret(uint8_t fretNum);
  bool releaseAll();

  // État
  int8_t getActiveFret() const { return activeFret; }
  bool isFretPressed(uint8_t fretNum) const;
};

#endif
