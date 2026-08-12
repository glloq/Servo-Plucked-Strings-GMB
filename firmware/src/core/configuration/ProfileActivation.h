// Two-phase profile-swap state (audit P2.17 — extracted from main.cpp).
//
// Activating a new profile is deferred: the OLD profile's fingers are first driven to
// rest and given time to lift (a controlled park) BEFORE the config is torn down, so a
// profile that removes/reassigns a finger servo can't leave a finger pressed while the
// new one arms. This owns the pending profile (RAII — no more scattered new/delete in
// main.cpp) and the time at which it may be applied.
//
// Pure C++17: no Arduino dependency, so the swap timing + ownership is unit-tested on
// the host (and leaks are caught by ASan).
#pragma once

#include <cstdint>

#include "Profile.h"

namespace gmb {

class ProfileActivation {
public:
    ProfileActivation() = default;
    ProfileActivation(const ProfileActivation&) = delete;
    ProfileActivation& operator=(const ProfileActivation&) = delete;
    ~ProfileActivation() { delete pending_; }

    // Begin (or replace) a pending swap: keep a copy of `p`, to be applied at applyAtMs.
    void begin(const Profile& p, uint32_t applyAtMs) {
        delete pending_;
        pending_ = new Profile(p);
        applyAtMs_ = applyAtMs;
    }

    bool pending() const { return pending_ != nullptr; }

    // If a swap is pending AND its mechanical wait has elapsed, hand the pending
    // profile to `apply` (by const ref) and clear it. Returns true iff a swap was
    // applied this call. No-op (false) otherwise.
    template <typename Apply>
    bool service(uint32_t nowMs, Apply apply) {
        if (!pending_) return false;
        if (static_cast<int32_t>(nowMs - applyAtMs_) < 0) return false;
        apply(static_cast<const Profile&>(*pending_));
        delete pending_;
        pending_ = nullptr;
        return true;
    }

    // Drop any pending swap without applying it (panic / hard stop).
    void cancel() {
        delete pending_;
        pending_ = nullptr;
    }

private:
    Profile* pending_ = nullptr;
    uint32_t applyAtMs_ = 0;
};

}  // namespace gmb
