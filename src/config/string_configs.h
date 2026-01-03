#ifndef STRING_CONFIGS_H
#define STRING_CONFIGS_H

#include <Arduino.h>
#include "settings.h"

// ========== STRUCTURE DE MAPPING SERVO ==========
/**
 * Permet de mapper individuellement chaque servo à un PCA et un pin
 * AVANTAGES:
 * - Câblage flexible: les frettes n'ont pas besoin d'être branchées dans l'ordre
 * - Réparation facile: si un pin PCA est défectueux, on peut utiliser un autre
 * - Optimisation du câble: on peut minimiser la longueur des câbles
 * - Multi-PCA: une corde peut utiliser plusieurs PCA si nécessaire
 */
struct ServoMapping {
  uint8_t pcaIndex;             // Index du PCA9685 (0 à PCA_COUNT-1)
  uint8_t pin;                  // Pin sur le PCA9685 (0-15)
};

// ========== STRUCTURE DE CALIBRATION FRETTE ==========
struct FretCalibration {
  uint16_t angleOpen;           // Angle position repos (corde libre)
  uint16_t angleClosed;         // Angle position activée (corde appuyée)
};

// ========== STRUCTURE DE CONFIGURATION ==========
struct StringConfig {
  uint8_t baseMidiNote;         // Note MIDI à vide
  uint8_t numFrets;             // Nombre de frettes

  // Mapping des servos de frettes (1 par frette)
  ServoMapping fretServos[MAX_FRETS];  // Mapping PCA+pin pour chaque frette

  // Mapping du servo de grattage
  ServoMapping pluckServo;      // Mapping PCA+pin pour le pluck

  // Calibration des frettes
  FretCalibration fretCalibration[MAX_FRETS];  // Open + Closed pour chaque frette
  bool fretReversed[MAX_FRETS];                // Sens inversé?

  // Calibration du pluck (oscillation autour d'un centre)
  uint16_t pluckAngleCenter;    // Position centrale repos (ex: 90°)
  uint16_t pluckAmplitude;      // Amplitude oscillation (ex: 15° → ±15°)
  uint16_t pluckMuteAngle;      // Angle pour étouffer (ex: 90°)
};

// ========== CONFIGURATION BASSE 4 CORDES ==========
// Accordage standard: E-A-D-G

const StringConfig stringConfigs[NUM_STRINGS] = {
  // ===== Corde 0: E2 (MIDI 40) =====
  {
    .baseMidiNote = 40,           // E2
    .numFrets = 12,

    // Mapping des servos de frettes
    .fretServos = {
      {0,0},  {0,1}, {0,2}, {0,3}, {0,4}, {0,5}, {0,6}, {0,7}, {0,8}, {0,9}, {0,10}, {0,11},
      // Frettes 13-24 non utilisées
      {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}
    },

    // Servo de grattage
    .pluckServo = {0, 12},

    // Calibration frettes: {angleOpen, angleClosed}
    .fretCalibration = {
      //  Open Closed
      {   45,  120  }, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {   45,  120  }, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      // Frettes 13-24 non utilisées
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}
    },

    // Sens de rotation
    .fretReversed = {
      false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false, false
    },

    // Calibration pluck
    .pluckAngleCenter = 90,
    .pluckAmplitude = 15,
    .pluckMuteAngle = 90
  },

  // ===== Corde 1: A2 (MIDI 45) =====
  {
    .baseMidiNote = 45,
    .numFrets = 12,

    .fretServos = {
      {1,0}, {1,1}, {1,2}, {1,3}, {1,4}, {1,5}, {1,6}, {1,7}, {1,8}, {1,9}, {1,10}, {1,11},
      {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}
    },

    .pluckServo = {1, 12},

    .fretCalibration = {
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}
    },

    .fretReversed = {
      false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false, false
    },

    .pluckAngleCenter = 90,
    .pluckAmplitude = 15,
    .pluckMuteAngle = 90
  },

  // ===== Corde 2: D3 (MIDI 50) =====
  {
    .baseMidiNote = 50,
    .numFrets = 12,

    .fretServos = {
      {2,0}, {2,1}, {2,2}, {2,3}, {2,4}, {2,5}, {2,6}, {2,7}, {2,8}, {2,9}, {2,10}, {2,11},
      {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}
    },

    .pluckServo = {2, 12},

    .fretCalibration = {
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}
    },

    .fretReversed = {
      false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false, false
    },

    .pluckAngleCenter = 90,
    .pluckAmplitude = 15,
    .pluckMuteAngle = 90
  },

  // ===== Corde 3: G3 (MIDI 55) =====
  {
    .baseMidiNote = 55,
    .numFrets = 12,

    .fretServos = {
      {3,0}, {3,1}, {3,2}, {3,3}, {3,4}, {3,5}, {3,6}, {3,7}, {3,8}, {3,9}, {3,10}, {3,11},
      {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}
    },

    .pluckServo = {3, 12},

    .fretCalibration = {
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}
    },

    .fretReversed = {
      false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false, false
    },

    .pluckAngleCenter = 90,
    .pluckAmplitude = 15,
    .pluckMuteAngle = 90
  }
};

#endif
