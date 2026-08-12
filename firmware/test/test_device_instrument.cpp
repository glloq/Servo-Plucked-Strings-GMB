// P1.13: the Device/Instrument split must be LOSSLESS — split a Profile into its two
// halves and merge them back to an equivalent, still-activatable Profile. Guards the
// boundary before any consumer or persistence migrates onto it.
#include "TestFramework.h"
#include "../src/core/configuration/DeviceInstrument.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"

using namespace gmb;

TEST(device_instrument_split_is_lossless) {
    Profile p = Profile::makeDefault("Guitar", 6, {40, 45, 50, 55, 59, 64}, 12);
    p.network.ssid = "studio";
    p.network.hostname = "gmb-guitar";
    p.midi.globalChannel = 3;
    CHECK(ProfileValidator::isActivatable(p));

    DeviceConfig d = deviceConfigOf(p);
    InstrumentProfile i = instrumentProfileOf(p);

    // Device half carries the machine fields...
    CHECK(d.boardIdentifier == p.boardIdentifier);
    CHECK(d.network.ssid == "studio");
    CHECK(d.network.hostname == "gmb-guitar");
    CHECK_EQ((int)d.pins.size(), (int)p.pins.size());
    // ...and the instrument half carries the musical fields.
    CHECK(i.instrument.name == "Guitar");
    CHECK_EQ((int)i.strings.size(), 6);
    CHECK_EQ((int)i.servos.size(), (int)p.servos.size());
    CHECK_EQ((int)i.midi.globalChannel, 3);

    // Merge back (base carries the profile-level metadata) → equivalent profile.
    Profile r = mergeProfile(d, i, p);
    CHECK(r.boardIdentifier == p.boardIdentifier);
    CHECK(r.reserveUsb == p.reserveUsb);
    CHECK(r.automaticPinAssignment == p.automaticPinAssignment);
    CHECK(r.network.ssid == p.network.ssid);
    CHECK(r.network.hostname == p.network.hostname);
    CHECK(r.instrument.name == p.instrument.name);
    CHECK_EQ((int)r.instrument.stringCount, (int)p.instrument.stringCount);
    CHECK_EQ((int)r.midi.globalChannel, (int)p.midi.globalChannel);
    CHECK_EQ((int)r.strings.size(), (int)p.strings.size());
    CHECK_EQ((int)r.servos.size(), (int)p.servos.size());
    CHECK_EQ((int)r.pins.size(), (int)p.pins.size());
    CHECK_EQ((int)r.profileVersion, (int)p.profileVersion);  // metadata preserved
    // The recombined profile is still a valid, activatable instrument.
    CHECK(ProfileValidator::isActivatable(r));
}

// A device with the SAME instrument on a different board is a plain re-merge — the
// instrument half is portable across devices (the whole point of the split).
TEST(instrument_is_portable_across_devices) {
    Profile p = Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
    InstrumentProfile tune = instrumentProfileOf(p);

    DeviceConfig other = deviceConfigOf(p);
    other.network.hostname = "gmb-other";
    Profile moved = mergeProfile(other, tune, p);
    CHECK(moved.network.hostname == "gmb-other");     // new device identity
    CHECK_EQ((int)moved.strings.size(), 4);           // same instrument
    CHECK(moved.instrument.name == "Ukulele");
}
