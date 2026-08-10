// Per-string configuration for a servo-per-fret instrument.
//
// This replaces the stepper-based AxisConfig: there is no carriage, no motion
// geometry and no homing. A string is simply an open pitch plus the highest fret
// it can reach. WHICH frets actually carry a finger servo is not a contiguous
// range — it is derived from the servo list (ServoConfig with function=="finger",
// a matching stringIndex and a fret number). Fret 0 is the open string and never
// needs a servo. See Profile::availableFretMask() / instrumentView().
//
// Pure C++17, no Arduino / ESP-IDF dependency (host-testable).
#pragma once

#include <cstdint>

namespace gmb {

struct StringConfig {
    bool enabled = true;
    uint8_t openNote = 40;  // MIDI note of the open string (fret 0)
    uint8_t maxFret = 12;   // highest reachable fret (= highest fret with a servo)
};

}  // namespace gmb
