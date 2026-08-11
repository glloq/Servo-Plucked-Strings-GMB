#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"
#include "../src/core/configuration/ServoStroke.h"
#include "../src/core/midi/Velocity.h"

using namespace gmb;

static Profile uke() {
    return Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
}

// Default servos declare a source, a string and a role. With servo-per-fret the
// default profile has one finger per fret plus one plucker per string.
TEST(default_servos_have_source_and_string) {
    Profile p = uke();
    CHECK(!p.servos.empty());
    int fingers = 0, plucks = 0;
    for (const auto& s : p.servos) {
        CHECK(s.source == ServoSource::Pca);
        CHECK(s.stringIndex >= 0);
        CHECK(s.function == "finger" || s.function == "pluck");
        if (s.function == "finger") { ++fingers; CHECK(s.fret >= 1); }
        else ++plucks;
    }
    CHECK_EQ(fingers, 4 * 12);   // 12 frets per string
    CHECK_EQ(plucks, 4);         // one plucker per string
    CHECK(ProfileValidator::isActivatable(p));
}

// One PCA per string: every servo of string i sits on board i.
TEST(default_wires_one_pca_per_string) {
    Profile p = uke();
    for (const auto& s : p.servos)
        CHECK_EQ((int)s.pcaBoard, (int)s.stringIndex);
}

// A direct-GPIO servo on a free pin is valid (works without any PCA).
TEST(direct_gpio_servo_is_valid) {
    Profile p = uke();
    ServoConfig strum;
    strum.enabled = true;
    strum.function = "strum";
    strum.stringIndex = 0;
    strum.source = ServoSource::DirectGpio;
    strum.gpio = 2;  // recommended free pin on the DevKitC-1
    p.servos.push_back(strum);
    CHECK(ProfileValidator::isActivatable(p));
}

// A direct servo on a reserved pin is rejected.
TEST(direct_servo_on_reserved_pin_rejected) {
    Profile p = uke();
    ServoConfig s;
    s.enabled = true;
    s.function = "damper";
    s.stringIndex = 0;
    s.source = ServoSource::DirectGpio;
    s.gpio = 19;  // USB pin
    p.servos.push_back(s);
    CHECK(!ProfileValidator::isActivatable(p));
}

// A direct servo clashing with an I2C bus pin is rejected.
TEST(direct_servo_conflicts_with_i2c_pin) {
    Profile p = uke();
    int8_t sda = -1;
    for (const auto& a : p.pins)
        if (a.signal == "SDA") sda = a.gpio;
    CHECK(sda >= 0);
    ServoConfig s;
    s.enabled = true;
    s.function = "strum";
    s.stringIndex = 1;
    s.source = ServoSource::DirectGpio;
    s.gpio = sda;
    p.servos.push_back(s);
    CHECK(!ProfileValidator::isActivatable(p));
}

// Two servos on the same PCA board+channel conflict (finger fret 1 of string 0
// already uses board 0 channel 0).
TEST(duplicate_pca_channel_rejected) {
    Profile p = uke();
    ServoConfig s;
    s.enabled = true;
    s.function = "damper";
    s.stringIndex = 0;
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = 0;
    p.servos.push_back(s);
    CHECK(!ProfileValidator::isActivatable(p));
}

// Up to eight PCA boards addressable (0..7); board 8 is rejected.
TEST(pca_board_range) {
    Profile p = uke();
    ServoConfig ok;
    ok.enabled = true; ok.function = "strum"; ok.stringIndex = 0;
    ok.source = ServoSource::Pca; ok.pcaBoard = 7; ok.channel = 0;  // free board
    p.servos.push_back(ok);
    CHECK(ProfileValidator::isActivatable(p));

    p.servos.back().pcaBoard = 8;  // out of range (max 8 boards -> 0..7)
    CHECK(!ProfileValidator::isActivatable(p));
}

// A per-string strum-lift servo paired with the string's pluck servo validates
// (channel 13 is free: fingers 0..11, pluck 12).
TEST(strum_lift_with_striker_is_valid) {
    Profile p = uke();
    ServoConfig lift;
    lift.enabled = true;
    lift.function = "strumLift";
    lift.stringIndex = 0;
    lift.source = ServoSource::Pca;
    lift.pcaBoard = 0;
    lift.channel = 13;
    p.servos.push_back(lift);
    CHECK(ProfileValidator::isActivatable(p));
}

// A per-string strum servo counts as the string's striker (no pluck required).
TEST(per_string_strum_satisfies_striker) {
    Profile p = uke();
    for (auto& s : p.servos)
        if (s.function == "pluck" && s.stringIndex == 0) s.function = "strum";
    CHECK(ProfileValidator::isActivatable(p));
}

// Every enabled string needs its own striker — there is no shared strummer.
TEST(string_without_striker_rejected) {
    Profile p = uke();
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "pluck" && it->stringIndex == 0) it = p.servos.erase(it);
        else ++it;
    }
    CHECK(!ProfileValidator::isActivatable(p));
}

// A strum lift with no striker to lift on its string is rejected.
TEST(strum_lift_without_striker_rejected) {
    Profile p = uke();
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "pluck" && it->stringIndex == 0) it = p.servos.erase(it);
        else ++it;
    }
    ServoConfig lift;
    lift.enabled = true;
    lift.function = "strumLift";
    lift.stringIndex = 0;
    lift.source = ServoSource::Pca;
    lift.pcaBoard = 0;
    lift.channel = 13;
    p.servos.push_back(lift);
    CHECK(!ProfileValidator::isActivatable(p));
}

// A finger servo needs a real fret (1..kMaxFret); fret 0 (open) has no servo.
TEST(finger_without_fret_rejected) {
    Profile p = uke();
    ServoConfig s;
    s.enabled = true;
    s.function = "finger";
    s.stringIndex = 0;
    s.fret = 0;  // invalid: fret 0 is the open string
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = 14;
    p.servos.push_back(s);
    CHECK(!ProfileValidator::isActivatable(p));
}

// Two finger servos claiming the same (string, fret) conflict.
TEST(duplicate_finger_fret_rejected) {
    Profile p = uke();
    ServoConfig s;
    s.enabled = true;
    s.function = "finger";
    s.stringIndex = 0;
    s.fret = 1;  // string 0 already has a finger on fret 1
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = 14;  // distinct channel, but same (string,fret)
    p.servos.push_back(s);
    CHECK(!ProfileValidator::isActivatable(p));
}

// Non-contiguous frets are allowed: a string may carry fingers on frets {1,3,5}
// with gaps at 2 and 4 and still activate.
TEST(non_contiguous_frets_allowed) {
    Profile p;
    p.instrument.stringCount = 1;
    StringConfig s;
    s.openNote = 40;
    s.maxFret = 5;
    p.strings.push_back(s);
    for (int f : {1, 3, 5}) {
        ServoConfig fg;
        fg.enabled = true; fg.function = "finger"; fg.stringIndex = 0;
        fg.fret = static_cast<int8_t>(f);
        fg.pcaBoard = 0; fg.channel = static_cast<uint8_t>(f);
        p.servos.push_back(fg);
    }
    ServoConfig pluck;
    pluck.enabled = true; pluck.function = "pluck"; pluck.stringIndex = 0;
    pluck.pcaBoard = 0; pluck.channel = 15;
    p.servos.push_back(pluck);
    p.selector.string.maximum = 1;
    p.selector.fret.maximum = 5;
    p.pins = uke().pins;  // borrow the reference SDA/SCL/SERVO_OE assignment
    CHECK(ProfileValidator::isActivatable(p));
}

// An absurd absolute pulse width (outside the safe servo window) is rejected.
TEST(servo_pulse_absolute_range_rejected) {
    Profile p = uke();
    p.servos[0].pulseMaxUs = 4000;  // > 3000 µs absolute ceiling
    CHECK(!ProfileValidator::isActivatable(p));
}

// A profile with no enabled string can never arm and is rejected.
TEST(zero_enabled_strings_rejected) {
    Profile p = uke();
    for (auto& s : p.strings) s.enabled = false;
    CHECK(!ProfileValidator::isActivatable(p));
}

// The current-draw governor is optional: a global cap of 0 means "no limit" and is
// a valid profile (the per-board cap can still bound it). A per-board cap above a
// PCA9685's 16 channels, however, is rejected.
TEST(zero_concurrent_moves_means_unlimited) {
    Profile p = uke();
    p.power.maxConcurrentMoves = 0;
    CHECK(ProfileValidator::isActivatable(p));
    p.power.maxConcurrentPerBoard = 17;
    CHECK(!ProfileValidator::isActivatable(p));
}

// When the selector is disabled its CC numbers are unused, so colliding
// string/fret CCs must NOT fail the profile.
TEST(disabled_selector_ignores_cc_collision) {
    Profile p = uke();
    p.selector.enabled = false;
    p.selector.string.ccNumber = 20;
    p.selector.fret.ccNumber = 20;  // identical, but selection is off
    CHECK(ProfileValidator::isActivatable(p));
}

// --- Strum stroke shaping (servoStrikeTargetUs) ---------------------------

static ServoConfig strumServo() {
    ServoConfig s;
    s.function = "strum";
    s.pulseMinUs = 500;
    s.pulseMaxUs = 2500;
    s.restUs = 1000;
    s.activeUs = 1800;
    return s;
}

// Velocity scales the strike depth linearly between rest and active.
TEST(strike_depth_follows_velocity) {
    ServoConfig s = strumServo();
    CHECK_EQ((int)servoStrikeTargetUs(s, 0.0, false), 1000);   // rest
    CHECK_EQ((int)servoStrikeTargetUs(s, 1.0, false), 1800);   // active
    CHECK_EQ((int)servoStrikeTargetUs(s, 0.5, false), 1400);   // midpoint
}

// minStrikeUs guarantees a floor depth so soft notes still catch the string.
TEST(min_strike_depth_floor) {
    ServoConfig s = strumServo();
    s.minStrikeUs = 1300;
    CHECK_EQ((int)servoStrikeTargetUs(s, 0.0, false), 1300);   // floored up
    CHECK_EQ((int)servoStrikeTargetUs(s, 1.0, false), 1800);   // full still reaches active
}

// Alternate direction: the up-stroke uses activeAltUs when provided.
TEST(alternate_stroke_uses_alt_endpoint) {
    ServoConfig s = strumServo();
    s.alternateDirection = true;
    s.activeAltUs = 600;
    CHECK_EQ((int)servoStrikeTargetUs(s, 1.0, false), 1800);   // down-stroke
    CHECK_EQ((int)servoStrikeTargetUs(s, 1.0, true), 600);     // up-stroke
}

// activeAltUs == 0 mirrors the active pulse about rest for a symmetric up-stroke.
TEST(alternate_stroke_mirrors_when_alt_zero) {
    ServoConfig s = strumServo();
    s.alternateDirection = true;   // activeAltUs stays 0
    // mirror of 1800 about rest 1000 = 2*1000 - 1800 = 200, clamped to pulseMin 500.
    CHECK_EQ((int)servoStrikeTargetUs(s, 1.0, true), 500);
}

// An out-of-window alternate/min pulse is rejected by validation.
TEST(strum_alt_pulse_out_of_range_rejected) {
    Profile p = uke();
    ServoConfig strum = strumServo();
    strum.enabled = true;
    strum.stringIndex = 0;
    strum.source = ServoSource::Pca;
    strum.pcaBoard = 0;
    strum.channel = 13;
    strum.activeAltUs = 3000;  // > pulseMaxUs
    p.servos.push_back(strum);
    CHECK(!ProfileValidator::isActivatable(p));
}

// A valid strum with alternation + floor + custom stroke time validates.
TEST(strum_stroke_fields_valid) {
    Profile p = uke();
    ServoConfig strum = strumServo();
    strum.enabled = true;
    strum.stringIndex = 0;
    strum.source = ServoSource::Pca;
    strum.pcaBoard = 0;
    strum.channel = 13;
    strum.alternateDirection = true;
    strum.activeAltUs = 700;
    strum.minStrikeUs = 1200;
    strum.strokeMs = 40;
    strum.engageDelayMs = 15;
    p.servos.push_back(strum);
    CHECK(ProfileValidator::isActivatable(p));
}

// Velocity curves are monotonic and bounded 0..1 (relocated from the old planner
// test; velocity shapes the strike depth above).
TEST(velocity_curves) {
    for (int curve = 0; curve <= 3; ++curve) {
        CHECK_NEAR(applyVelocityCurve(curve, 0), 0.0, 1e-9);
        CHECK_NEAR(applyVelocityCurve(curve, 127), 1.0, 1e-9);
        double prev = -1.0;
        for (int v = 0; v <= 127; ++v) {
            double y = applyVelocityCurve(curve, static_cast<uint8_t>(v));
            CHECK(y >= -1e-9 && y <= 1.0 + 1e-9);
            CHECK(y >= prev - 1e-9);  // monotonic non-decreasing
            prev = y;
        }
    }
}
