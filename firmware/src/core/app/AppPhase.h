// Application lifecycle phase (audit P2.17).
//
// This is the *application-level* view of where the runtime is — layered on top of
// the SafetyManager state machine, not a replacement for it. `Ready` means the
// instrument is armed and playing; the boot/parking/reconfiguring phases gate that.
// The enum lived inline in main.cpp; extracting it here makes the phase->label
// mapping (surfaced over /api/diagnostics and /api/status) host-testable and gives a
// future ApplicationRuntime a shared, portable home for its lifecycle type.
#pragma once

namespace gmb {

enum class AppPhase { ConfigSafe, Boot, Parking, Reconfiguring, Ready };

// Stable wire label for a phase. `degraded` only refines the Ready phase (one or more
// strings disabled by a fault but the instrument is still armed and playable). Kept
// byte-identical to the original inline switch so the web UI / diagnostics contract
// does not change.
inline const char* appPhaseName(AppPhase phase, bool degraded) {
    switch (phase) {
        case AppPhase::Ready:         return degraded ? "readyDegraded" : "ready";
        case AppPhase::Parking:       return "parking";
        case AppPhase::Reconfiguring: return "reconfiguring";
        case AppPhase::ConfigSafe:    return "configSafe";
        case AppPhase::Boot:          break;
    }
    return "boot";
}

}  // namespace gmb
