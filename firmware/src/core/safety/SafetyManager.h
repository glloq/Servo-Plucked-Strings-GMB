// Safety & fault handling (spec section 21).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace gmb {

// Runtime safety state machine. The startup path is explicit (spec §13/§21, P0):
//
//   PowerOnSafe --(profile validated)--> Parking --(mechanical settle)--> Armed
//
// With NO valid profile the machine latches in ConfigSafe: the web/network come up
// so a profile can be built or loaded, but no actuator is ever driven and no MIDI
// reaches the mechanics. The firmware must never fabricate + arm a default profile
// on a real machine.
enum class SafetyState : uint8_t {
    ConfigSafe,     // no valid profile — actuators locked out, awaiting configuration
    PowerOnSafe,    // outputs disabled (/OE high), servos neutralised, queues empty
    Parking,        // profile validated, outputs live, servos travelling to rest
    Armed,          // normal operation
    Panic,          // software panic latched
    EmergencyStop,  // hardware E-stop asserted
};

// Configurable behaviour when Wi-Fi is lost (spec 21.4). See SafetyConfig for how a
// profile selects one; the runtime applies the selected policy on link loss.
enum class WifiLossBehavior : uint8_t {
    FinishThenStop = 0,   // default: cancel pending, controlled release, stay armed
    StopImmediately = 1,  // controlled park immediately (outputs cut, stay armed)
    ContinueQueued = 2,   // keep playing the already-queued notes (do nothing special)
    IdleKeepMotors = 3,   // cancel pending but keep servos energised at rest
};

struct FaultRecord {
    std::string source;
    std::string message;
    uint32_t atMs = 0;
};

class SafetyManager {
public:
    SafetyState state() const { return state_; }

    // At power-up everything is neutralised, outputs disabled (spec 21.1).
    void boot() { state_ = SafetyState::PowerOnSafe; }

    // No valid profile is available: latch a safe state where actuators can never
    // move (actuatorsAllowed() stays false) but the web/network stay up so a profile
    // can be built or loaded. The firmware must NEVER auto-apply a fabricated
    // fallback profile to real hardware (P0 boot-safe).
    void configSafe() { state_ = SafetyState::ConfigSafe; }

    // Begin the arming sequence once the profile is validated and pins checked:
    //   PowerOnSafe -> Parking. `parkWaitMs` is the mechanical time the caller must
    // allow for every servo to travel to rest and settle — max(travelMs+settleMs).
    // Refuses (stays put) unless the state is a clean PowerOnSafe; a panic / E-stop /
    // ConfigSafe must be reset() first. Returns true when parking has begun.
    bool beginParking(bool profileValid, bool pinsValid, uint32_t parkWaitMs,
                      uint32_t nowMs) {
        if (state_ != SafetyState::PowerOnSafe || !profileValid || !pinsValid)
            return false;
        state_ = SafetyState::Parking;
        parkStartMs_ = nowMs;
        parkWaitMs_ = parkWaitMs;
        return true;
    }

    // Advance the Parking phase. Returns true EXACTLY on the tick when the mechanical
    // settle has elapsed and the state transitions Parking -> Armed (the note engine
    // may start from that point). No-op / false in any other state.
    bool tickParking(uint32_t nowMs) {
        if (state_ != SafetyState::Parking) return false;
        if (static_cast<int32_t>(nowMs - (parkStartMs_ + parkWaitMs_)) < 0) return false;
        state_ = SafetyState::Armed;
        return true;
    }

    // Milliseconds still to wait before Parking completes (0 outside Parking).
    uint32_t parkRemainingMs(uint32_t nowMs) const {
        if (state_ != SafetyState::Parking) return 0;
        int32_t rem = static_cast<int32_t>((parkStartMs_ + parkWaitMs_) - nowMs);
        return rem > 0 ? static_cast<uint32_t>(rem) : 0;
    }

    // Direct arm, skipping the Parking wait (PowerOnSafe -> Armed). Kept for a
    // zero-travel profile and for unit tests; the runtime uses beginParking/tickParking
    // so the mechanical settle is always honoured.
    bool arm(bool profileValid, bool pinsValid) {
        if (state_ == SafetyState::PowerOnSafe && profileValid && pinsValid) {
            state_ = SafetyState::Armed;
            return true;
        }
        return false;
    }

    // Software panic (spec 21.3): the caller must flush the MIDI queue, cancel
    // motion/plucks, hard-stop the servos, disable motors; this records the cause and
    // latches the state.
    void panic(const std::string& cause, uint32_t nowMs);

    // Hardware emergency stop (spec 21.2).
    void emergencyStop(uint32_t nowMs);

    // Clear a latched panic / E-stop / ConfigSafe back to the safe state (a re-arm is
    // then required to reach Armed).
    void reset() { state_ = SafetyState::PowerOnSafe; }

    // Are actuators allowed to respond to MIDI / play right now? Only when Armed —
    // ConfigSafe, PowerOnSafe and Parking all keep the note engine AND mechanical
    // tests locked out, so nothing moves before Ready.
    bool actuatorsAllowed() const { return state_ == SafetyState::Armed; }

    // True while the arming sequence is running its mechanical settle (Parking).
    bool parking() const { return state_ == SafetyState::Parking; }

    void recordFault(const std::string& source, const std::string& msg, uint32_t nowMs);
    const std::vector<FaultRecord>& faults() const { return faults_; }
    void clearFaults() { faults_.clear(); }

private:
    SafetyState state_ = SafetyState::PowerOnSafe;
    uint32_t parkStartMs_ = 0;
    uint32_t parkWaitMs_ = 0;
    std::vector<FaultRecord> faults_;
};

}  // namespace gmb
