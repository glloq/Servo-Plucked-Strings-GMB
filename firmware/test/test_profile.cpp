#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"

using namespace gmb;

static Profile guitarProfile() {
    return Profile::makeDefault("Guitar", 6, {40, 45, 50, 55, 59, 64}, 12);
}

// Acceptance criterion 15: profiles can be built and are valid by default.
TEST(default_profile_is_activatable) {
    Profile p = guitarProfile();
    auto issues = ProfileValidator::validate(p);
    for (auto& i : issues)
        if (i.severity == ValidationIssue::Severity::Error)
            std::printf("  unexpected error: %s: %s\n", i.field.c_str(),
                        i.message.c_str());
    CHECK(ProfileValidator::isActivatable(p));
}

TEST(default_profile_auto_assigns_pins) {
    Profile p = guitarProfile();
    CHECK(!p.pins.empty());
    // Auto-assignment must be conflict-free.
    const BoardProfile* b = builtinBoardProfile(p.boardIdentifier);
    CHECK(b != nullptr);
    PinManager pm(*b);
    pm.set(p.pins);
    CHECK(pm.validate(true).empty());
}

TEST(string_count_mismatch_is_error) {
    Profile p = guitarProfile();
    p.instrument.stringCount = 4;  // but 6 axes configured
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(same_cc_for_string_and_fret_is_error) {
    Profile p = guitarProfile();
    p.selector.fret.ccNumber = p.selector.string.ccNumber;  // 20 == 20
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(channel_mode_cc_is_rejected) {
    Profile p = guitarProfile();
    p.selector.string.ccNumber = 120;  // channel-mode message
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(zero_timeout_is_error) {
    Profile p = guitarProfile();
    p.selector.selectionTimeoutMs = 0;
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(instrument_view_from_profile) {
    Profile p = guitarProfile();
    InstrumentView v = p.instrumentView();
    CHECK_EQ((int)v.stringCount, 6);
    CHECK_EQ((int)v.openNotes[0], 40);
    CHECK_EQ((int)v.openNotes[5], 64);
}

// ---- two I2C buses -------------------------------------------------------
static void addPin(Profile& p, const char* sig, SignalKind kind, int8_t gpio) {
    PinAssignment a;
    a.signal = sig;
    a.kind = kind;
    a.gpio = gpio;
    p.pins.push_back(a);
}

// A PCA board placed on the second I2C bus (i2cBus = 1) needs its own SDA2/SCL2,
// otherwise the profile cannot activate; adding them makes it valid again.
TEST(second_bus_requires_sda2_scl2) {
    Profile p = guitarProfile();
    for (auto& s : p.servos)
        if (s.source == ServoSource::Pca && s.pcaBoard == 0) s.i2cBus = 1;
    CHECK(!ProfileValidator::isActivatable(p));  // missing SDA2/SCL2
    addPin(p, "SDA2", SignalKind::I2cSda, 38);
    addPin(p, "SCL2", SignalKind::I2cScl, 39);
    auto issues = ProfileValidator::validate(p);
    for (auto& i : issues)
        if (i.severity == ValidationIssue::Severity::Error)
            std::printf("  unexpected error: %s: %s\n", i.field.c_str(), i.message.c_str());
    CHECK(ProfileValidator::isActivatable(p));  // now valid
}

// The same board+channel on DIFFERENT buses is a different chip (allowed); on the
// SAME bus it is a real collision (rejected).
TEST(same_channel_on_different_buses_is_allowed) {
    Profile p = guitarProfile();
    addPin(p, "SDA2", SignalKind::I2cSda, 38);
    addPin(p, "SCL2", SignalKind::I2cScl, 39);
    int a = -1, b = -1;
    for (size_t i = 0; i < p.servos.size(); ++i)
        if (p.servos[i].source == ServoSource::Pca && p.servos[i].pcaBoard == 0) {
            if (a < 0) a = (int)i;
            else { b = (int)i; break; }
        }
    CHECK(a >= 0 && b >= 0);
    p.servos[b].channel = p.servos[a].channel;  // same channel...
    p.servos[b].i2cBus = 1;                      // ...but a different bus -> OK
    CHECK(ProfileValidator::isActivatable(p));
    p.servos[b].i2cBus = 0;                      // same bus now -> collision
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(i2c_bus_out_of_range_is_error) {
    Profile p = guitarProfile();
    p.servos[0].i2cBus = 2;  // only 0 and 1 exist on the ESP32-S3
    CHECK(!ProfileValidator::isActivatable(p));
}
