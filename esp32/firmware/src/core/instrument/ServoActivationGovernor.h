// Servo start-permit governor — limits PCA9685 in-rush current.
//
// A hobby servo draws its peak current in the first few milliseconds of a move,
// when it slews hardest toward the new target. Re-fretting a whole chord at once
// would start many fingers together and stack those peaks, browning out the 5-6 V
// rail / tripping the PCA9685. This governor spreads the STARTS: it grants at most
// `maxConcurrentMoves` start-permits within any rolling `staggerMs` window, so a
// burst of presses is fanned out over time instead of firing simultaneously.
//
// It complements the two other current-limiting measures: per-servo disableAtRest
// (idle fingers cut their PWM entirely) and the release-before-press sequence (one
// finger holding per string at a time). Pure C++17, host-testable.
#pragma once

#include <cstdint>
#include <vector>

namespace gmb {

class ServoActivationGovernor {
public:
    // maxConcurrent is clamped to >= 1. staggerMs == 0 disables throttling (every
    // request is granted immediately).
    void configure(uint8_t maxConcurrent, uint16_t staggerMs) {
        maxConcurrent_ = maxConcurrent < 1 ? 1 : maxConcurrent;
        staggerMs_ = staggerMs;
        reset();
    }

    void reset() {
        recent_.assign(maxConcurrent_, 0);
        head_ = 0;
        filled_ = 0;
    }

    // Ask to start a servo move at nowMs. Returns true if a permit is granted (and
    // the start is recorded); false if the caller should wait and retry next tick.
    // Guarantees at most maxConcurrent grants within any staggerMs window.
    bool requestStart(uint32_t nowMs) {
        if (staggerMs_ == 0) return true;  // throttling disabled
        if (recent_.size() != maxConcurrent_) reset();
        if (filled_ < maxConcurrent_) {           // window not yet full: grant
            recent_[head_] = nowMs;
            head_ = (head_ + 1) % maxConcurrent_;
            ++filled_;
            return true;
        }
        // Window full: the slot at head_ holds the oldest of the last N grants.
        uint32_t oldest = recent_[head_];
        if (static_cast<int32_t>(nowMs - oldest) >= static_cast<int32_t>(staggerMs_)) {
            recent_[head_] = nowMs;              // oldest aged out -> reuse its slot
            head_ = (head_ + 1) % maxConcurrent_;
            return true;
        }
        return false;                            // too many recent starts: wait
    }

private:
    uint8_t maxConcurrent_ = 3;
    uint16_t staggerMs_ = 8;
    std::vector<uint32_t> recent_;  // ring of the last maxConcurrent_ grant times
    uint8_t head_ = 0;
    uint8_t filled_ = 0;
};

}  // namespace gmb
