// Pure plucking-plan resolution (unit-tested on the host).
//
// The plucking "gesture" and the Note-Off mute behaviour are configured ONCE in a
// global PluckConfig (common to every string) instead of servo by servo. These
// helpers turn that global intent into the concrete per-string decision the servo
// scheduler acts on, given what each string actually has wired. Kept out of
// ServoBank / main.cpp (platform code) so the logic is unit-tested natively without
// the Arduino runtime — the same split as ServoStroke.h / FingerTarget.h.
//
// Every rule keeps a bare profile (no `pluck` block, PluckConfig at its defaults)
// byte-for-byte identical to the historical behaviour.
#pragma once

#include <cstdint>

#include "Profile.h"

namespace gmb {

// Effective stroke-engage time for a striker: the global PluckConfig.strokeMs when
// it is set (non-zero), otherwise the servo's own strokeMs (which itself falls back
// to travelMs inside ServoBank). A zero global therefore leaves each striker exactly
// as it was.
inline uint16_t effectivePluckStrokeMs(const PluckConfig& pk, const ServoConfig& striker) {
    return pk.strokeMs != 0 ? pk.strokeMs : striker.strokeMs;
}

// Effective minimum strike pulse for a striker: the global PluckConfig.minStrikePct
// (a percentage of the rest->active span) when set, otherwise the servo's own
// minStrikeUs. The percentage form is servo-independent — it means the same "soft
// notes still catch" depth on every string regardless of each plectrum's pulse
// window. The result lands between rest and active, so it is always inside the pulse
// window. A zero global leaves each servo's minStrikeUs untouched.
inline uint16_t effectivePluckMinStrikeUs(const PluckConfig& pk, const ServoConfig& s) {
    if (pk.minStrikePct == 0) return s.minStrikeUs;
    int pct = pk.minStrikePct > 100 ? 100 : pk.minStrikePct;
    int span = static_cast<int>(s.activeUs) - static_cast<int>(s.restUs);
    int v = static_cast<int>(s.restUs) + span * pct / 100;
    if (v < 0) v = 0;
    return static_cast<uint16_t>(v);
}

// True when a striker can damp with its own plectrum (a mute position is calibrated).
inline bool strikerCanPlectrumMute(const ServoConfig& striker) {
    return striker.muteUs != 0;
}

// In RaiseToPlay mode a strum lift RESTS ON the string, so letting it fall back to
// rest at Note Off mutes the note — the lift itself is the damper and no other mute
// action is needed (nor wanted: pressing anything else would fight it). In the
// default LowerToPlay mode the lift rests clear, so muting comes from elsewhere.
// Only meaningful on a string that actually has a lift.
inline bool liftMutesAtRest(const PluckConfig& pk, bool hasLift) {
    return pk.liftEngage == LiftEngage::RaiseToPlay && hasLift;
}

// Resolve the abstract mute policy to the CONCRETE actuator to use at Note Off,
// given what the string has wired (a damper servo? a striker with a mute angle? a
// strum lift?). `Auto` reproduces the historical rule exactly — a damper mutes if
// present, otherwise the string is left to ring. Explicit choices degrade safely
// when their actuator is missing (e.g. Plectrum with no mute angle falls back to a
// damper if there is one, else to None) so a half-configured instrument never hangs.
inline MuteSource resolvePluckMute(const PluckConfig& pk, bool hasDamper,
                                   bool strikerHasMute, bool hasLift) {
    switch (pk.muteSource) {
        case MuteSource::Auto:
            return hasDamper ? MuteSource::Damper : MuteSource::None;
        case MuteSource::Damper:
            return hasDamper ? MuteSource::Damper : MuteSource::None;
        case MuteSource::Plectrum:
            if (strikerHasMute) return MuteSource::Plectrum;
            return hasDamper ? MuteSource::Damper : MuteSource::None;
        case MuteSource::Lift:
            if (hasLift) return MuteSource::Lift;
            return hasDamper ? MuteSource::Damper : MuteSource::None;
        case MuteSource::None:
        default:
            return MuteSource::None;
    }
}

}  // namespace gmb
