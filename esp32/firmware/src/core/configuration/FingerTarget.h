// Pure finger-target resolution for the (possibly geared) finger servos.
//
// A "geared" finger servo drives two antagonistic fingers through a gear: it
// presses fret `fret` at `activeUs` (side A) and fret `fretB` at `activeBUs`
// (side B), and lifts BOTH at `restUs` (the neutral position). A plain single
// finger leaves `fretB` at -1 and behaves exactly as before (side A only).
//
// This maths is kept out of ServoBank (a platform class) so it can be unit-tested
// natively without the Arduino runtime — the same split as ServoStroke.h. Pure
// C++17, no Arduino / ESP-IDF dependency.
#pragma once

#include <cstdint>

#include "Profile.h"

namespace gmb {

// True when this finger servo drives a second fret through a gear (paired finger).
inline bool isGearedFinger(const ServoConfig& s) {
    return s.function == "finger" && s.fretB >= 1;
}

// True when this finger servo presses `fret` — as side A (`fret`) or, for a geared
// servo, as side B (`fretB`). Fret 0 (open string) never has a finger.
inline bool fingerServesFret(const ServoConfig& s, int fret) {
    if (s.function != "finger" || fret < 1) return false;
    if (fret == s.fret) return true;
    return s.fretB >= 1 && fret == s.fretB;
}

// The active pulse that presses `fret`: the side-B pulse (`activeBUs`) for a geared
// servo's second fret, otherwise the side-A pulse (`activeUs`) — which is also the
// only active pulse of a plain single finger. `restUs` stays the neutral
// (both-lifted) position and is applied by the bank's release() path.
inline uint16_t fingerActiveUsForFret(const ServoConfig& s, int fret) {
    if (s.fretB >= 1 && fret == s.fretB) return s.activeBUs;
    return s.activeUs;
}

// Estimated travel time (ms) to move a finger from the pulse `fromUs` to `toUs`,
// scaled from the servo's calibrated press time (`travelMs` = time to travel a
// rest->active press span). Used for a DIRECT geared sweep A<->B (skipping neutral):
// that motion is longer than a single press, so the wait must scale with the real
// pulse distance — an equal distance keeps the same time, a same-side re-press
// returns 0. Falls back to travelMs when the press span is uncalibrated (0).
inline uint16_t fingerSweepMs(const ServoConfig& s, uint16_t fromUs, uint16_t toUs) {
    int refSpan = s.activeUs >= s.restUs ? static_cast<int>(s.activeUs) - static_cast<int>(s.restUs)
                                         : static_cast<int>(s.restUs) - static_cast<int>(s.activeUs);
    if (refSpan <= 0) return s.travelMs;  // uncalibrated press span: safe fallback
    int dist = fromUs >= toUs ? static_cast<int>(fromUs) - static_cast<int>(toUs)
                              : static_cast<int>(toUs) - static_cast<int>(fromUs);
    long ms = static_cast<long>(s.travelMs) * dist / refSpan;
    if (ms < 0) ms = 0;
    if (ms > 4000) ms = 4000;  // safety bound against a mis-calibrated span
    return static_cast<uint16_t>(ms);
}

}  // namespace gmb
