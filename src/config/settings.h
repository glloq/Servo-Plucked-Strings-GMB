#ifndef SETTINGS_H
#define SETTINGS_H

// ========== CONFIGURATION MATÉRIELLE ==========
#define NUM_STRINGS 4              // Nombre de cordes
#define PCA_COUNT 4                // Nombre de PCA9685
#define PCA9685_BASE_ADDR 0x40     // Adresse I2C de base
#define PIN_OE 4                   // Pin Output Enable (inversé, LOW = enable)
#define I2C_FREQUENCY 400000       // 400kHz

// ========== TIMING (en millisecondes) ==========
#define FRET_STABILIZATION_DELAY 100  // Délai stabilisation frette
#define PLUCK_DELAY 50                // Durée impulsion pluck
#define SERVO_TIMEOUT 5000            // Timeout inactivité avant coupure

// ========== CALIBRATION SERVO ==========
#define SERVO_MIN_PULSE 150        // Pulse min (≈1ms sur 4096)
#define SERVO_MAX_PULSE 600        // Pulse max (≈2ms sur 4096)
#define SERVO_FREQ 50              // Fréquence PWM (Hz)

// ========== MIDI ==========
#define MIDI_CHANNEL_OMNI 0        // Écoute tous les canaux
#define MIDI_BAUD 31250            // Vitesse MIDI standard

// ========== MODES DE JEU ==========
#define LEGATO_MODE false          // true = pas de re-pluck sur même corde
#define AUTO_MUTE true             // true = mute automatique sur NOTE_OFF
#define VELOCITY_SENSITIVE false   // true = velocity → force pluck

// ========== DEBUG ==========
#define DEBUG                      // Activer logs série
//#define DEBUG_VERBOSE            // Logs détaillés
//#define DEBUG_SERIAL_COMMANDS    // Commandes test via série
//#define STARTUP_TEST             // Test au démarrage

// ========== PARAMÈTRES AVANCÉS ==========
#define MAX_FRETS 24               // Nombre maximum de frettes par corde
#define SERIAL_BAUD 115200         // Vitesse communication série

#endif
