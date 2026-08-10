// Tests for the global plucking configuration: the pure mute-resolution / gesture
// helpers (PluckPlan.h) and the validator rules for muteUs / pluck.muteSource.
#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/PluckPlan.h"
#include "../src/core/configuration/ProfileValidator.h"

using namespace gmb;

static Profile uke() {
    return Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
}

// Give every string's plucker a plectrum-mute angle inside its pulse window.
static void giveAllPluckersMute(Profile& p, uint16_t us) {
    for (auto& s : p.servos)
        if (s.function == "pluck" || s.function == "strum") s.muteUs = us;
}

// ---- PluckPlan: Note-Off mute resolution ---------------------------------

// Auto reproduces the historical rule exactly: a damper mutes if present,
// otherwise the string is left to ring — even if the plectrum COULD mute.
TEST(mute_auto_matches_legacy) {
    PluckConfig pk;  // default = Auto
    CHECK(resolvePluckMute(pk, true, false, false) == MuteSource::Damper);
    CHECK(resolvePluckMute(pk, false, false, false) == MuteSource::None);
    CHECK(resolvePluckMute(pk, false, true, true) == MuteSource::None);
}

// Plectrum muting uses the plectrum when it has a mute angle, else degrades to a
// damper if one exists, else to nothing — never hangs on a half setup.
TEST(mute_plectrum_degrades_safely) {
    PluckConfig pk; pk.muteSource = MuteSource::Plectrum;
    CHECK(resolvePluckMute(pk, false, true, false) == MuteSource::Plectrum);
    CHECK(resolvePluckMute(pk, true, false, false) == MuteSource::Damper);
    CHECK(resolvePluckMute(pk, false, false, false) == MuteSource::None);
}

// Lift muting uses the lift, else falls back to a damper / nothing.
TEST(mute_lift_degrades_safely) {
    PluckConfig pk; pk.muteSource = MuteSource::Lift;
    CHECK(resolvePluckMute(pk, false, false, true) == MuteSource::Lift);
    CHECK(resolvePluckMute(pk, true, false, false) == MuteSource::Damper);
    CHECK(resolvePluckMute(pk, false, false, false) == MuteSource::None);
}

// Damper forces the damper and degrades to nothing when absent.
TEST(mute_damper_requires_damper) {
    PluckConfig pk; pk.muteSource = MuteSource::Damper;
    CHECK(resolvePluckMute(pk, true, true, true) == MuteSource::Damper);
    CHECK(resolvePluckMute(pk, false, true, true) == MuteSource::None);
}

// None never damps, whatever is wired.
TEST(mute_none_never_damps) {
    PluckConfig pk; pk.muteSource = MuteSource::None;
    CHECK(resolvePluckMute(pk, true, true, true) == MuteSource::None);
}

// ---- PluckPlan: global gesture overlay -----------------------------------

// A zero global stroke inherits each servo's own; a set global overrides it.
TEST(global_stroke_overrides_else_inherits) {
    PluckConfig pk;
    ServoConfig s; s.strokeMs = 40;
    CHECK_EQ((int)effectivePluckStrokeMs(pk, s), 40);
    pk.strokeMs = 90;
    CHECK_EQ((int)effectivePluckStrokeMs(pk, s), 90);
}

TEST(striker_can_plectrum_mute_flag) {
    ServoConfig s;
    CHECK(!strikerCanPlectrumMute(s));
    s.muteUs = 1200;
    CHECK(strikerCanPlectrumMute(s));
}

// ---- PluckPlan: lift engagement direction --------------------------------

TEST(lift_default_is_lower_to_play) {
    Profile p = uke();
    CHECK(p.pluck.liftEngage == LiftEngage::LowerToPlay);
}

// A raise-to-play lift damps by resting ON the string; lower-to-play rests clear,
// and a string with no lift never mutes via the lift whatever the mode.
TEST(lift_raise_mutes_at_rest_only_with_lift) {
    PluckConfig pk;
    CHECK(!liftMutesAtRest(pk, true));   // lower-to-play, has lift -> no
    pk.liftEngage = LiftEngage::RaiseToPlay;
    CHECK(liftMutesAtRest(pk, true));    // raise-to-play + lift -> the lift is the damper
    CHECK(!liftMutesAtRest(pk, false));  // raise-to-play but no lift -> nothing rests on it
}

TEST(lift_engage_both_directions_valid) {
    Profile p = uke();
    p.pluck.liftEngage = LiftEngage::RaiseToPlay;
    CHECK(ProfileValidator::isActivatable(p));
    p.pluck.liftEngage = LiftEngage::LowerToPlay;
    CHECK(ProfileValidator::isActivatable(p));
}

// ---- Validator: muteUs + muteSource --------------------------------------

// A bare profile keeps the historical defaults and is activatable.
TEST(bare_profile_pluck_defaults) {
    Profile p = uke();
    CHECK(p.pluck.muteSource == MuteSource::Auto);
    CHECK_EQ((int)p.pluck.strokeMs, 0);
    CHECK_EQ((int)p.pluck.fretToPluckMs, 0);
    CHECK(ProfileValidator::isActivatable(p));
}

// A plectrum-mute angle inside the servo window is valid (warning-free when set).
TEST(plectrum_mute_angle_in_window_valid) {
    Profile p = uke();
    giveAllPluckersMute(p, 1300);
    p.pluck.muteSource = MuteSource::Plectrum;
    CHECK(ProfileValidator::isActivatable(p));
}

// A mute angle outside the servo's pulse window is a hard error.
TEST(mute_angle_out_of_window_rejected) {
    Profile p = uke();
    for (auto& s : p.servos)
        if (s.function == "pluck" && s.stringIndex == 0) s.muteUs = 5000;  // > pulseMaxUs
    CHECK(!ProfileValidator::isActivatable(p));
}

// Plectrum muting with a plucker that has no mute angle warns (but still activates,
// so a half-configured instrument is not blocked).
TEST(plectrum_mute_without_angle_warns_not_blocks) {
    Profile p = uke();
    p.pluck.muteSource = MuteSource::Plectrum;  // no muteUs anywhere
    bool warned = false;
    for (const auto& iss : ProfileValidator::validate(p))
        if (iss.field == "pluck.muteSource" &&
            iss.severity == ValidationIssue::Severity::Warning)
            warned = true;
    CHECK(warned);
    CHECK(ProfileValidator::isActivatable(p));  // warning, not error
}
