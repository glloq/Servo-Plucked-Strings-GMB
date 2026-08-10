// Geared / paired finger: one servo drives two antagonistic fingers (two frets on
// one string) through a gear. Covers the pure target maths, the availability mask,
// end-to-end routing (allocator + selector), and the validator rules — plus that a
// geared pair really halves the finger-servo count while staying activatable.
#include "TestFramework.h"
#include "../src/core/configuration/FingerTarget.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"
#include "../src/core/instrument/NoteAllocator.h"
#include "../src/core/midi/StringFretSelector.h"

using namespace gmb;

static Profile uke() {
    return Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
}

// Turn the plain finger on (string, fretA) into a geared servo that also drives
// fretB, and remove fretB's now-redundant standalone servo. Returns the profile
// with one fewer servo covering the same two frets.
static Profile makeGeared(int stringIndex, int fretA, int fretB, uint16_t activeBUs) {
    Profile p = uke();
    // Drop the standalone finger on fretB.
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "finger" && it->stringIndex == stringIndex && it->fret == fretB)
            it = p.servos.erase(it);
        else
            ++it;
    }
    // Gear the fretA servo to also press fretB (side B). The neutral (restUs) is
    // the both-lifted position and must sit BETWEEN the two press pulses.
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == stringIndex && s.fret == fretA) {
            s.fretB = static_cast<int8_t>(fretB);
            s.activeBUs = activeBUs;
            s.restUs = static_cast<uint16_t>((s.activeUs + activeBUs) / 2);
        }
    return p;
}

// ---- Pure target maths (FingerTarget.h) ----------------------------------

TEST(geared_finger_detection) {
    ServoConfig plain;
    plain.function = "finger"; plain.fret = 3;
    CHECK(!isGearedFinger(plain));

    ServoConfig geared;
    geared.function = "finger"; geared.fret = 3; geared.fretB = 4;
    CHECK(isGearedFinger(geared));

    ServoConfig pluck;
    pluck.function = "pluck"; pluck.fretB = 4;  // fretB ignored on non-finger
    CHECK(!isGearedFinger(pluck));
}

TEST(finger_serves_both_sides) {
    ServoConfig s;
    s.function = "finger"; s.fret = 3; s.fretB = 5;
    CHECK(fingerServesFret(s, 3));   // side A
    CHECK(fingerServesFret(s, 5));   // side B
    CHECK(!fingerServesFret(s, 4));  // neither
    CHECK(!fingerServesFret(s, 0));  // open string never has a finger

    ServoConfig plain;
    plain.function = "finger"; plain.fret = 7;  // fretB stays -1
    CHECK(fingerServesFret(plain, 7));
    CHECK(!fingerServesFret(plain, 8));
}

TEST(finger_active_pulse_picks_the_right_side) {
    ServoConfig s;
    s.function = "finger";
    s.fret = 3;  s.activeUs = 1800;   // side A
    s.fretB = 5; s.activeBUs = 1200;  // side B
    CHECK_EQ((int)fingerActiveUsForFret(s, 3), 1800);
    CHECK_EQ((int)fingerActiveUsForFret(s, 5), 1200);

    ServoConfig plain;
    plain.function = "finger"; plain.fret = 3; plain.activeUs = 1700;  // fretB = -1
    CHECK_EQ((int)fingerActiveUsForFret(plain, 3), 1700);
    CHECK_EQ((int)fingerActiveUsForFret(plain, 99), 1700);  // fallback = side A
}

// A direct A<->B sweep crosses the whole span, so its wait scales with the real
// pulse distance from the calibrated press time (neutral->side = travelMs).
TEST(finger_sweep_time_scales_with_distance) {
    ServoConfig s;
    s.function = "finger";
    s.restUs = 1500; s.activeUs = 1900;   // side A: 400 µs from neutral
    s.fretB = 2; s.activeBUs = 1100;       // side B: 400 µs from neutral
    s.travelMs = 120;                      // calibrated press (neutral -> side)
    CHECK_EQ((int)fingerSweepMs(s, 1900, 1900), 0);     // same side: no motion
    CHECK_EQ((int)fingerSweepMs(s, 1900, 1100), 240);   // A->B = full span = 2x press
    CHECK_EQ((int)fingerSweepMs(s, 1500, 1900), 120);   // neutral->side = one press
    ServoConfig bad = s; bad.activeUs = 1500;            // press span 0 (uncalibrated)
    CHECK_EQ((int)fingerSweepMs(bad, 1100, 1900), (int)bad.travelMs);  // fallback
}

// ---- Availability mask + routing -----------------------------------------

// A geared finger contributes BOTH of its frets to the availability mask.
TEST(geared_mask_covers_both_frets) {
    Profile p;
    p.instrument.stringCount = 1;
    StringConfig s; s.openNote = 40; s.maxFret = 7;
    p.strings.push_back(s);

    ServoConfig geared;  // one servo: frets 1 (side A) + 2 (side B)
    geared.enabled = true; geared.function = "finger"; geared.stringIndex = 0;
    geared.fret = 1; geared.fretB = 2; geared.activeBUs = 1600;
    geared.channel = 0;
    p.servos.push_back(geared);

    ServoConfig plain;  // plain finger on fret 5
    plain.enabled = true; plain.function = "finger"; plain.stringIndex = 0;
    plain.fret = 5; plain.channel = 1;
    p.servos.push_back(plain);

    uint32_t m = p.availableFretMask(0);
    CHECK((m >> 1) & 1u);        // side A
    CHECK((m >> 2) & 1u);        // side B
    CHECK(!((m >> 3) & 1u));     // gap
    CHECK((m >> 5) & 1u);        // plain finger
    CHECK(!((m >> 4) & 1u));

    InstrumentView v = p.instrumentView();
    CHECK(v.fretAvailable(0, 0));   // open always
    CHECK(v.fretAvailable(0, 1));
    CHECK(v.fretAvailable(0, 2));
    CHECK(!v.fretAvailable(0, 3));
    CHECK(v.fretAvailable(0, 5));
}

// The allocator can auto-pick both a geared servo's frets, but not a gap.
TEST(allocator_plays_both_geared_frets) {
    NoteAllocator alloc;
    StringSpec s;
    s.openNote = 40; s.maxFret = 5; s.enabled = true;
    s.fretMask = (1u << 1) | (1u << 2);  // one geared servo covers frets 1 & 2
    s.hasFretMask = true;                 // honour the mask strictly (fret 3 is a gap)
    alloc.setStrings({s});
    CHECK(alloc.canPlay(0, 40));   // open
    CHECK(alloc.canPlay(0, 41));   // fret 1 (side A)
    CHECK(alloc.canPlay(0, 42));   // fret 2 (side B)
    CHECK(!alloc.canPlay(0, 43));  // fret 3: no servo
}

// ---- Validator rules ------------------------------------------------------

// A geared pair covering two adjacent frets is valid AND drops one servo.
TEST(geared_pair_is_valid_and_saves_a_servo) {
    Profile plain = uke();
    int plainCount = static_cast<int>(plain.servos.size());
    Profile p = makeGeared(0, 1, 2, 1600);
    CHECK_EQ(static_cast<int>(p.servos.size()), plainCount - 1);  // one fewer servo
    CHECK(ProfileValidator::isActivatable(p));
    // Both frets still route.
    InstrumentView v = p.instrumentView();
    CHECK(v.fretAvailable(0, 1));
    CHECK(v.fretAvailable(0, 2));
}

// The geared neutral (restUs) must lie strictly between the two press pulses; a
// neutral outside that band leaves one side pressed at "rest" (audit P-B1).
TEST(geared_neutral_outside_press_range_rejected) {
    Profile p = makeGeared(0, 1, 2, 1100);  // side A 1800 (default), side B 1100
    CHECK(ProfileValidator::isActivatable(p));  // makeGeared set a valid neutral
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == 0 && s.fret == 1)
            s.restUs = 900;  // below BOTH presses -> not a "both-lifted" neutral
    CHECK(!ProfileValidator::isActivatable(p));
}

// The two frets of a geared finger must differ.
TEST(geared_same_fret_rejected) {
    Profile p = uke();
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == 0 && s.fret == 1) {
            s.fretB = 1;          // side A == side B
            s.activeBUs = 1600;
        }
    CHECK(!ProfileValidator::isActivatable(p));
}

// A geared finger's second fret must be a real fret (1..kMaxFret).
TEST(geared_out_of_range_fret_rejected) {
    Profile p = makeGeared(0, 1, 2, 1600);
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == 0 && s.fret == 1)
            s.fretB = 25;  // > kMaxFret (24)
    CHECK(!ProfileValidator::isActivatable(p));
}

// Side B needs its own in-window active pulse.
TEST(geared_side_b_pulse_out_of_window_rejected) {
    Profile p = makeGeared(0, 1, 2, 1600);
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == 0 && s.fret == 1)
            s.activeBUs = 2600;  // > pulseMaxUs (2500)
    CHECK(!ProfileValidator::isActivatable(p));
}

// A geared side-B fret colliding with another servo's fret is rejected (the fret
// is claimed twice). Here fret 2 has both its own servo AND the geared side B.
TEST(geared_side_b_duplicate_fret_rejected) {
    Profile p = uke();  // keeps the standalone finger on fret 2
    for (auto& s : p.servos)
        if (s.function == "finger" && s.stringIndex == 0 && s.fret == 1) {
            s.fretB = 2;          // collides with the existing fret-2 finger
            s.activeBUs = 1600;
        }
    CHECK(!ProfileValidator::isActivatable(p));
}

// Explicit CC selection honours a geared servo's side-B fret like any other.
TEST(selector_honours_geared_side_b) {
    StringFretSelector sel;
    SelectorConfig cfg;
    cfg.mode = SelectionMode::Explicit;
    cfg.string.maximum = 1;
    cfg.fret.maximum = 5;
    sel.configure(cfg);

    InstrumentView v;
    v.stringCount = 1;
    v.openNotes = {40};
    v.maxFretPerString = {5};
    v.availableFretMask = {(1u << 1) | (1u << 2)};  // geared servo: frets 1 & 2
    sel.setInstrument(v);

    MidiEvent ccStr;
    ccStr.type = static_cast<uint8_t>(MidiType::ControlChange);
    ccStr.channel = 0; ccStr.data1 = 20; ccStr.data2 = 1; ccStr.timestampUs = 0;
    sel.onControlChange(ccStr);
    MidiEvent ccFret;
    ccFret.type = static_cast<uint8_t>(MidiType::ControlChange);
    ccFret.channel = 0; ccFret.data1 = 21; ccFret.data2 = 2; ccFret.timestampUs = 1;
    sel.onControlChange(ccFret);
    MidiEvent on;
    on.type = static_cast<uint8_t>(MidiType::NoteOn);
    on.channel = 0; on.data1 = 42; on.data2 = 100; on.timestampUs = 2;  // 40 + fret 2
    NoteResolution r = sel.onNoteOn(on, 3);
    CHECK(r.play);
    CHECK(r.source == ResolveSource::Explicit);  // side B routed explicitly
    CHECK_EQ((int)r.fret, 2);
}
