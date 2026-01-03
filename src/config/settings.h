#ifndef SETTINGS_H
#define SETTINGS_H

// ========== HARDWARE CONFIGURATION ==========
#define NUM_STRINGS 4              // Number of strings
#define PCA_COUNT 4                // Number of PCA9685 controllers
#define PCA9685_BASE_ADDR 0x40     // Base I2C address
#define PIN_OE 4                   // Output Enable pin (inverted, LOW = enable)
#define I2C_FREQUENCY 400000       // 400kHz

// ========== TIMING (in milliseconds) ==========
#define FRET_STABILIZATION_DELAY 100  // Fret stabilization delay
#define PLUCK_DELAY 50                // Pluck impulse duration
#define SERVO_TIMEOUT 5000            // Inactivity timeout before power off

// ========== SERVO CALIBRATION ==========
#define SERVO_MIN_PULSE 150        // Min pulse (≈1ms on 4096)
#define SERVO_MAX_PULSE 600        // Max pulse (≈2ms on 4096)
#define SERVO_FREQ 50              // PWM frequency (Hz)

// ========== MIDI ==========
// MIDIUSB is used (native USB, no serial configuration needed)
// All MIDI channels are automatically listened to

// ========== PLAYING MODES ==========
#define LEGATO_MODE false          // true = no re-pluck on same string
#define AUTO_MUTE true             // true = automatic mute on NOTE_OFF
#define VELOCITY_SENSITIVE false   // true = velocity → pluck force

// ========== DEBUG ==========
#define DEBUG                      // Enable serial logs
//#define DEBUG_VERBOSE            // Detailed logs
//#define DEBUG_SERIAL_COMMANDS    // Serial test commands
//#define STARTUP_TEST             // Startup test

// ========== ADVANCED PARAMETERS ==========
#define MAX_FRETS 24               // Maximum number of frets per string
#define SERIAL_BAUD 115200         // Serial communication speed

#endif
