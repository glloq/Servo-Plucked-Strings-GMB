// Actuator movement manager (audit P1.6).
//
// Sits between the playback scheduler and the ServoBank:
//
//     PlaybackScheduler -> ActuatorManager -> PowerGovernor -> ServoBank
//
// and decides whether a movement must WAIT for a power-governor start-permit. It
// encodes the one distinction the mission calls out: musical sound must never be
// throttled, but the current-hungry positioning moves can be spread to bound the
// PCA9685 in-rush.
//
//   • Deadline   movements (a pluck / strum STRIKE) must fire on the sonic beat —
//                they are ALWAYS permitted, never governed.
//   • Staggerable movements (a finger PRESS, a strum-lift ENGAGE) draw their peak
//                current at start and have slack, so they go through the governor's
//                global + per-board caps and staggerMs window.
//
// Pure C++17 wrapping the (already unit-tested) ServoActivationGovernor, so the
// deadline-vs-staggerable policy itself is host-testable.
#pragma once

#include <cstdint>

#include "ServoActivationGovernor.h"

namespace gmb {

enum class MoveClass : uint8_t {
    Staggerable,  // finger press / release / strum-lift engage — governed
    Deadline,     // pluck / strum strike — must hit the beat, never governed
};

class ActuatorManager {
public:
    // Configure the underlying governor: global cap (0 = none), per-PCA-board cap
    // (0 = none) and the stagger window (0 = throttling off).
    void configure(uint8_t maxConcurrent, uint8_t maxPerBoard, uint16_t staggerMs) {
        governor_.configure(maxConcurrent, maxPerBoard, staggerMs);
    }
    void reset() { governor_.reset(); }

    // May a movement of class `cls` START now on PCA board bucket `board` (0xFF = a
    // servo on no board, e.g. direct GPIO — only the global cap applies)? Deadline
    // movements are always permitted; staggerable ones defer to the governor.
    bool requestMove(MoveClass cls, uint32_t nowMs, uint8_t board = 0xFF) {
        if (cls == MoveClass::Deadline) return true;  // sound: never throttled
        return governor_.requestStart(nowMs, board);
    }

    // Cumulative staggerable starts the governor deferred (diagnostics, P2.19).
    uint32_t throttleCount() const { return governor_.throttleCount(); }

private:
    ServoActivationGovernor governor_;
};

}  // namespace gmb
