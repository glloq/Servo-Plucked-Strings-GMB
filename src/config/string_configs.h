#ifndef STRING_CONFIGS_H
#define STRING_CONFIGS_H

#include <Arduino.h>
#include "settings.h"

// ========== SERVO MAPPING STRUCTURE ==========
/**
 * Allows individual mapping of each servo to a PCA and pin
 * ADVANTAGES:
 * - Flexible wiring: frets don't need to be connected in order
 * - Easy repair: if a PCA pin is defective, another can be used
 * - Cable optimization: cable length can be minimized
 * - Multi-PCA: a string can use multiple PCAs if necessary
 */
struct ServoMapping {
  uint8_t pcaIndex;             // PCA9685 index (0 to PCA_COUNT-1)
  uint8_t pin;                  // Pin on the PCA9685 (0-15)
};

// ========== FRET CALIBRATION STRUCTURE ==========
struct FretCalibration {
  uint16_t angleOpen;           // Rest position angle (string free)
  uint16_t angleClosed;         // Activated position angle (string pressed)
};

// ========== CONFIGURATION STRUCTURE ==========
struct StringConfig {
  uint8_t baseMidiNote;         // Open string MIDI note
  uint8_t numFrets;             // Number of frets

  // Fret servo mapping (1 per fret)
  ServoMapping fretServos[MAX_FRETS];  // PCA+pin mapping for each fret

  // Plucking servo mapping
  ServoMapping pluckServo;      // PCA+pin mapping for pluck

  // Fret calibration
  FretCalibration fretCalibration[MAX_FRETS];  // Open + Closed for each fret
  bool fretReversed[MAX_FRETS];                // Reversed direction?

  // Pluck calibration (oscillation around center)
  uint16_t pluckAngleCenter;    // Center rest position (e.g. 90°)
  uint16_t pluckAmplitude;      // Oscillation amplitude (e.g. 15° → ±15°)
  uint16_t pluckMuteAngle;      // Muting angle (e.g. 90°)
};

// ========== 4-STRING BASS CONFIGURATION ==========
// Standard tuning: E-A-D-G

const StringConfig stringConfigs[NUM_STRINGS] = {
  // ===== String 0: E2 (MIDI 40) =====
  {
    .baseMidiNote = 40,           // E2
    .numFrets = 12,

    // Fret servo mapping
    .fretServos = {
      {0,0},  {0,1}, {0,2}, {0,3}, {0,4}, {0,5}, {0,6}, {0,7}, {0,8}, {0,9}, {0,10}, {0,11},
      // Frets 13-24 unused
      {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}, {0,0}
    },

    // Plucking servo
    .pluckServo = {0, 12},

    // Fret calibration: {angleOpen, angleClosed}
    .fretCalibration = {
      //  Open Closed
      {   45,  120  }, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      {   45,  120  }, {45, 120}, {45, 120}, {45, 120}, {45, 120}, {45, 120},
      // Frets 13-24 unused
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90},
      {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}, {90, 90}
    },

    // Rotation direction
    .fretReversed = {
      false, false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false, false
    },

    // Pluck calibration
    .pluckAngleCenter = 90,
    .pluckAmplitude = 15,
    .pluckMuteAngle = 90
  },

  // ===== String 1: A2 (MIDI 45) =====
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

  // ===== String 2: D3 (MIDI 50) =====
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
