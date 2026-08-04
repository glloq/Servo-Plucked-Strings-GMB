// Servo-per-fret model: non-contiguous fret positions, availability masks, and
// how the allocator + selector refuse a fret that has no dedicated finger servo.
#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/gmb/Capabilities.h"
#include "../src/core/instrument/NoteAllocator.h"
#include "../src/core/midi/StringFretSelector.h"

using namespace gmb;

// Build a one-string profile whose finger servos sit on an arbitrary fret set.
static Profile makeGappyProfile(const std::vector<int>& frets, uint8_t maxFret) {
    Profile p;
    p.instrument.stringCount = 1;
    StringConfig s;
    s.openNote = 40;
    s.maxFret = maxFret;
    p.strings.push_back(s);
    for (int f : frets) {
        ServoConfig finger;
        finger.enabled = true;
        finger.function = "finger";
        finger.stringIndex = 0;
        finger.fret = static_cast<int8_t>(f);
        finger.channel = static_cast<uint8_t>(f);
        p.servos.push_back(finger);
    }
    ServoConfig pluck;
    pluck.enabled = true;
    pluck.function = "pluck";
    pluck.stringIndex = 0;
    pluck.channel = 15;
    p.servos.push_back(pluck);
    return p;
}

// availableFretMask reflects exactly the wired frets, not a contiguous range.
TEST(available_fret_mask_is_sparse) {
    Profile p = makeGappyProfile({1, 3, 5, 12}, 12);
    uint32_t m = p.availableFretMask(0);
    CHECK((m >> 1) & 1u);
    CHECK(!((m >> 2) & 1u));   // gap
    CHECK((m >> 3) & 1u);
    CHECK(!((m >> 4) & 1u));   // gap
    CHECK((m >> 5) & 1u);
    CHECK((m >> 12) & 1u);
    CHECK(!((m >> 6) & 1u));
}

// The capability snapshot announces DISCRETE notes for a non-contiguous fretboard
// (a host must not be told it can play a fret with no servo) — audit P1-2.
TEST(capabilities_discrete_for_gapped_fretboard) {
    Profile p = makeGappyProfile({1, 3, 5}, 5);  // openNote 40, gaps at frets 2 & 4
    CapabilitySnapshot snap = buildSnapshot(p);
    CHECK_EQ((int)snap.capabilities.noteMode, 1);       // discrete, not continuous
    bool has41 = false, has43 = false, has45 = false, has42 = false, has44 = false;
    for (uint8_t n : snap.capabilities.discreteNotes) {
        if (n == 41) has41 = true;   // fret 1
        if (n == 42) has42 = true;   // gap
        if (n == 43) has43 = true;   // fret 3
        if (n == 44) has44 = true;   // gap
        if (n == 45) has45 = true;   // fret 5
    }
    CHECK(has41 && has43 && has45);
    CHECK(!has42 && !has44);         // gaps are NOT announced as playable
    CHECK_EQ((int)snap.capabilities.noteMin, 40);       // open string
    CHECK_EQ((int)snap.capabilities.noteMax, 45);
}

// A fully-wired (contiguous) string is announced as a continuous range.
TEST(capabilities_continuous_for_full_fretboard) {
    Profile p = makeGappyProfile({1, 2, 3, 4, 5}, 5);   // every fret wired
    CapabilitySnapshot snap = buildSnapshot(p);
    CHECK_EQ((int)snap.capabilities.noteMode, 0);       // continuous
}

// InstrumentView.fretAvailable: open always; wired frets yes; gaps/over-range no.
TEST(instrument_view_fret_available) {
    Profile p = makeGappyProfile({1, 3, 5}, 5);
    InstrumentView v = p.instrumentView();
    CHECK(v.fretAvailable(0, 0));    // open string always playable
    CHECK(v.fretAvailable(0, 1));
    CHECK(!v.fretAvailable(0, 2));   // gap
    CHECK(v.fretAvailable(0, 3));
    CHECK(!v.fretAvailable(0, 4));   // gap
    CHECK(v.fretAvailable(0, 5));
    CHECK(!v.fretAvailable(0, 6));   // beyond maxFret
}

// The allocator never auto-picks a fret that has no finger servo.
TEST(allocator_skips_gap_frets) {
    NoteAllocator alloc;
    StringSpec s;
    s.openNote = 40;
    s.maxFret = 5;
    s.enabled = true;
    s.fretMask = (1u << 1) | (1u << 3) | (1u << 5);  // frets 1,3,5 wired
    s.fretMaskValid = true;                           // authoritative mask
    alloc.setStrings({s});

    CHECK(alloc.canPlay(0, 40));   // open (fret 0) always
    CHECK(alloc.canPlay(0, 41));   // fret 1 wired
    CHECK(!alloc.canPlay(0, 42));  // fret 2 gap
    CHECK(alloc.canPlay(0, 43));   // fret 3 wired
    CHECK(!alloc.canPlay(0, 44));  // fret 4 gap
    CHECK(alloc.canPlay(0, 45));   // fret 5 wired
    CHECK(!alloc.canPlay(0, 46));  // beyond maxFret
}

// No authoritative mask (fretMaskValid=false) means "assume every fret in range
// is wired" (chromatic back-compat for callers/tests that don't wire servos).
TEST(allocator_no_mask_allows_range) {
    NoteAllocator alloc;
    StringSpec s;
    s.openNote = 40;
    s.maxFret = 5;
    s.enabled = true;
    s.fretMask = 0;
    s.fretMaskValid = false;  // no authoritative mask
    alloc.setStrings({s});
    for (int n = 40; n <= 45; ++n) CHECK(alloc.canPlay(0, static_cast<uint8_t>(n)));
    CHECK(!alloc.canPlay(0, 46));
}

// A fretted string with an AUTHORITATIVE empty mask (maxFret>0 but no finger
// servos) can only play its open string — never a wrong pitch (audit P1-1).
TEST(allocator_fingerless_fretted_string_only_open) {
    NoteAllocator alloc;
    StringSpec s;
    s.openNote = 40;
    s.maxFret = 5;
    s.enabled = true;
    s.fretMask = 0;
    s.fretMaskValid = true;   // authoritative: no frets wired
    alloc.setStrings({s});
    CHECK(alloc.canPlay(0, 40));       // open plays
    for (int n = 41; n <= 45; ++n) CHECK(!alloc.canPlay(0, static_cast<uint8_t>(n)));
}

static MidiEvent cc(uint8_t ch, uint8_t num, uint8_t val, uint32_t t) {
    MidiEvent e;
    e.type = static_cast<uint8_t>(MidiType::ControlChange);
    e.channel = ch; e.data1 = num; e.data2 = val; e.timestampUs = t;
    return e;
}
static MidiEvent noteOn(uint8_t ch, uint8_t note, uint8_t vel, uint32_t t) {
    MidiEvent e;
    e.type = static_cast<uint8_t>(MidiType::NoteOn);
    e.channel = ch; e.data1 = note; e.data2 = vel; e.timestampUs = t;
    return e;
}

// An explicit CC selection of a fret with no servo falls back to automatic
// allocation rather than commanding an unplayable position (invalidValuePolicy
// = AutomaticFallback, the default).
TEST(selector_rejects_unwired_fret) {
    StringFretSelector sel;
    SelectorConfig cfg;
    cfg.mode = SelectionMode::Explicit;
    cfg.string.maximum = 1;
    cfg.fret.maximum = 5;
    cfg.fret.invalidValuePolicy = InvalidValuePolicy::AutomaticFallback;
    sel.configure(cfg);

    InstrumentView v;
    v.stringCount = 1;
    v.openNotes = {40};
    v.maxFretPerString = {5};
    v.availableFretMask = {(1u << 1) | (1u << 3) | (1u << 5)};  // gap at 2, 4
    sel.setInstrument(v);

    // Select string 1, fret 2 (a gap) then play note 42 (=40+2).
    sel.onControlChange(cc(0, 20, 1, 0));
    sel.onControlChange(cc(0, 21, 2, 1));
    NoteResolution r = sel.onNoteOn(noteOn(0, 42, 100, 2), 3);
    CHECK(r.play);
    CHECK(r.source == ResolveSource::Automatic);  // fell back, not Explicit

    // A wired fret (3) is honoured explicitly.
    sel.onControlChange(cc(0, 20, 1, 10));
    sel.onControlChange(cc(0, 21, 3, 11));
    NoteResolution r2 = sel.onNoteOn(noteOn(0, 43, 100, 12), 13);
    CHECK(r2.play);
    CHECK(r2.source == ResolveSource::Explicit);
    CHECK_EQ((int)r2.fret, 3);
}
