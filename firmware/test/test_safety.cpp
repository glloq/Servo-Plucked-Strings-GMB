// Regression tests for the P0 boot-safe + Parking/Arming state machine.
//
// The boot decision itself lives in main.cpp (Arduino-gated), but every invariant it
// relies on is expressed on the host-testable SafetyManager: no actuator may move
// unless the state is Armed, ConfigSafe latches with no valid profile, and Armed is
// reachable only through the Parking mechanical settle.
#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"
#include "../src/core/instrument/InstrumentController.h"
#include "../src/core/safety/SafetyManager.h"

using namespace gmb;

// --- P0.1: the CONFIG_SAFE empty profile can never arm, and loads without crashing.
// This is the core guarantee behind boot-safe: with no valid profile the runtime
// holds an EMPTY Profile, which the validator rejects (so armInstrument refuses) and
// which the instrument loads as zero strings (so nothing is ever driven).
TEST(empty_config_safe_profile_is_never_activatable) {
    Profile empty;                                   // what main.cpp holds in CONFIG_SAFE
    CHECK(!ProfileValidator::isActivatable(empty));  // can never be armed
    InstrumentController ic;
    ic.load(empty);                                  // must not crash / touch actuators
    CHECK_EQ((int)ic.stringCount(), 0);
    CHECK_EQ(ic.soundingCount(), 0);
}

// --- P0.1: no valid profile => ConfigSafe, actuators locked, cannot arm ---

TEST(configsafe_locks_actuators_until_a_profile_is_loaded) {
    SafetyManager s;
    s.boot();
    CHECK(s.state() == SafetyState::PowerOnSafe);
    CHECK(!s.actuatorsAllowed());          // nothing moves at boot

    s.configSafe();                        // no valid profile at boot
    CHECK(s.state() == SafetyState::ConfigSafe);
    CHECK(!s.actuatorsAllowed());          // and still nothing moves

    // A machine in ConfigSafe must NOT be armable directly — the empty/invalid
    // profile has to be replaced by a valid one (which goes through reset()).
    CHECK(!s.beginParking(true, true, 100, 0));
    CHECK(!s.arm(true, true));
    CHECK(s.state() == SafetyState::ConfigSafe);

    // Loading a valid profile clears ConfigSafe (reset -> PowerOnSafe) and only THEN
    // can parking begin.
    s.reset();
    CHECK(s.state() == SafetyState::PowerOnSafe);
    CHECK(s.beginParking(true, true, 100, 0));
    CHECK(s.state() == SafetyState::Parking);
}

// --- P0.2: Parking waits max(travel+settle) before Armed; no play meanwhile ---

TEST(parking_blocks_play_until_mechanical_settle_elapses) {
    SafetyManager s;
    s.boot();
    CHECK(s.beginParking(true, true, 250, 1000));  // 250 ms park, started at t=1000
    CHECK(s.parking());
    CHECK(!s.actuatorsAllowed());                  // no MIDI note / test during Parking

    // Before the wait elapses: still Parking, still locked.
    CHECK(!s.tickParking(1100));
    CHECK(s.state() == SafetyState::Parking);
    CHECK(!s.actuatorsAllowed());
    CHECK_EQ((int)s.parkRemainingMs(1100), 150);

    // Exactly at the deadline: transition Parking -> Armed, exactly once.
    CHECK(s.tickParking(1250));
    CHECK(s.state() == SafetyState::Armed);
    CHECK(s.actuatorsAllowed());                   // play allowed only now
    CHECK(!s.tickParking(1300));                   // no second transition
    CHECK_EQ((int)s.parkRemainingMs(1300), 0);
}

// A zero-travel instrument still transitions cleanly (no negative wait / underflow).
TEST(parking_zero_wait_arms_on_first_tick) {
    SafetyManager s;
    s.boot();
    CHECK(s.beginParking(true, true, 0, 5000));
    CHECK(s.tickParking(5000));
    CHECK(s.state() == SafetyState::Armed);
}

// --- P0.2: parking refuses an invalid profile / pins ---

TEST(parking_refuses_invalid_profile_or_pins) {
    SafetyManager s;
    s.boot();
    CHECK(!s.beginParking(false, true, 100, 0));   // invalid profile
    CHECK(s.state() == SafetyState::PowerOnSafe);
    CHECK(!s.beginParking(true, false, 100, 0));   // invalid pins
    CHECK(s.state() == SafetyState::PowerOnSafe);
    CHECK(!s.actuatorsAllowed());
}

// --- P0.3 / §21: a panic or E-stop latches and blocks arming until reset ---

TEST(panic_and_estop_latch_and_block_arming) {
    SafetyManager s;
    s.boot();
    s.beginParking(true, true, 100, 0);
    s.tickParking(1000);
    CHECK(s.state() == SafetyState::Armed);

    s.panic("test", 2000);
    CHECK(s.state() == SafetyState::Panic);
    CHECK(!s.actuatorsAllowed());
    CHECK(!s.beginParking(true, true, 100, 2000));  // cannot arm through a latched panic
    CHECK(!s.arm(true, true));

    s.reset();                                      // explicit recovery
    CHECK(s.state() == SafetyState::PowerOnSafe);
    CHECK(s.beginParking(true, true, 100, 3000));   // arming allowed again

    // E-stop likewise latches from any state.
    s.emergencyStop(4000);
    CHECK(s.state() == SafetyState::EmergencyStop);
    CHECK(!s.actuatorsAllowed());
    CHECK(!s.beginParking(true, true, 100, 4000));
}

// The whole point: actuatorsAllowed() is true in EXACTLY one state (Armed) and
// false in every safe/latched state, so nothing moves before Ready.
TEST(actuators_allowed_only_when_armed) {
    SafetyManager s;
    s.configSafe();   CHECK(!s.actuatorsAllowed());
    s.boot();         CHECK(!s.actuatorsAllowed());  // PowerOnSafe
    s.beginParking(true, true, 100, 0);
    CHECK(!s.actuatorsAllowed());                    // Parking
    s.tickParking(1000);
    CHECK(s.actuatorsAllowed());                     // Armed — the only one
    s.panic("x", 0);  CHECK(!s.actuatorsAllowed());
    s.reset();        CHECK(!s.actuatorsAllowed());
    s.emergencyStop(0); CHECK(!s.actuatorsAllowed());
}
