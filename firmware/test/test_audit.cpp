// Regression tests for the second audit's P0/P1 findings.
#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/configuration/ProfileValidator.h"
#include "../src/core/gmb/Capabilities.h"
#include "../src/core/instrument/InstrumentController.h"
#include "../src/core/midi/MidiParser.h"
#include "../src/core/midi/StringFretSelector.h"

using namespace gmb;

static Profile uke() {
    return Profile::makeDefault("Ukulele", 4, {67, 60, 64, 69}, 12);
}
static MidiEvent cc(uint8_t ch, uint8_t n, uint8_t v, uint32_t t = 0) {
    MidiEvent e; e.type = (uint8_t)MidiType::ControlChange;
    e.channel = ch; e.data1 = n; e.data2 = v; e.timestampUs = t; return e;
}
static MidiEvent noteOn(uint8_t ch, uint8_t note, uint8_t vel, uint32_t t = 0) {
    MidiEvent e; e.type = (uint8_t)MidiType::NoteOn;
    e.channel = ch; e.data1 = note; e.data2 = vel; e.timestampUs = t; return e;
}
static MidiEvent noteOff(uint8_t ch, uint8_t note, uint32_t t = 0) {
    MidiEvent e; e.type = (uint8_t)MidiType::NoteOff;
    e.channel = ch; e.data1 = note; e.timestampUs = t; return e;
}

// --- Validator hardening (P0 #3) ---

TEST(validator_requires_i2c_and_oe_for_pca) {
    Profile p = uke();  // default servos are PCA
    for (auto it = p.pins.begin(); it != p.pins.end();) {
        if (it->signal == "SDA" || it->signal == "SCL" || it->signal == "SERVO_OE")
            it = p.pins.erase(it);
        else ++it;
    }
    CHECK(!ProfileValidator::isActivatable(p));
}

// Servo-per-fret: a fretted string with no finger servo can still play its open
// string safely (frets are routed only when wired), so it is a WARNING, not a
// blocking error — a partial install must still activate.
TEST(fretted_string_without_finger_is_warning_not_error) {
    Profile p = uke();
    CHECK(ProfileValidator::isActivatable(p));
    for (auto& sv : p.servos)
        if (sv.function == "finger" && sv.stringIndex == 0) sv.enabled = false;
    CHECK(ProfileValidator::isActivatable(p));  // still activatable...
    bool warned = false;
    for (const auto& is : ProfileValidator::validate(p))
        if (is.field == "servos.finger" &&
            is.severity == ValidationIssue::Severity::Warning)
            warned = true;
    CHECK(warned);                               // ...but flagged
    // And string 0 now has no available fretted positions.
    CHECK_EQ((int)p.availableFretMask(0), 0);
}

TEST(validator_rejects_unknown_board) {
    Profile p = uke();
    p.boardIdentifier = "totally-unknown-board";
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(validator_rejects_cc_collisions) {
    // String-select CC colliding with volume (CC7) is rejected.
    Profile v = uke();
    v.selector.string.ccNumber = 7;
    CHECK(!ProfileValidator::isActivatable(v));
    // Sustain CC colliding with the fret CC (when sustain is enabled) is rejected.
    Profile s = uke();
    s.midi.sustainPedal = true;
    s.midi.sustainCc = s.selector.fret.ccNumber;
    CHECK(!ProfileValidator::isActivatable(s));
}

TEST(validator_rejects_midi_transpose_out_of_range) {
    Profile p = uke();
    p.midi.transpose = 60;  // > 48
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(validator_rejects_non_permutation_mapping) {
    Profile p = uke();
    p.selector.string.mapping = {0, 0, 2, 3};  // axis 0 twice, axis 1 unreachable
    CHECK(!ProfileValidator::isActivatable(p));
    p.selector.string.mapping = {3, 2, 1, 0};  // a real permutation is fine
    CHECK(ProfileValidator::isActivatable(p));
}

TEST(validator_rejects_out_of_range_enum) {
    Profile p = uke();
    p.midi.saturationStrategy = static_cast<SaturationStrategy>(99);
    CHECK(!ProfileValidator::isActivatable(p));
}

TEST(validator_rejects_out_of_range_rest_pulse) {
    Profile p = uke();
    p.servos[0].restUs = 3000;  // > pulseMaxUs (2500)
    CHECK(!ProfileValidator::isActivatable(p));
}

// A finger whose rest == active can never lift: stuck note, breaks the one-finger-
// per-string invariant (audit P-B1).
TEST(validator_rejects_rest_equals_active) {
    Profile p = uke();
    CHECK(ProfileValidator::isActivatable(p));
    p.servos[0].restUs = p.servos[0].activeUs;  // finger stuck pressed
    CHECK(!ProfileValidator::isActivatable(p));
}

// An absurd motion/global time is a typo that would stall a note for tens of
// seconds; the validator rejects it (audit P-B3).
TEST(validator_rejects_absurd_timing) {
    Profile p = uke();
    p.servos[0].travelMs = 60000;  // ~60 s finger move
    CHECK(!ProfileValidator::isActivatable(p));
    Profile q = uke();
    q.midi.noteExecutionDelayMs = 60000;
    CHECK(!ProfileValidator::isActivatable(q));
    Profile r = uke();
    r.power.staggerMs = 5000;
    CHECK(!ProfileValidator::isActivatable(r));
}

// An alternate up-stroke whose implicit mirror (2*rest-active) falls outside the
// pulse window is silently clamped — the validator warns (audit P-B7).
TEST(validator_warns_alternate_mirror_out_of_window) {
    Profile p = uke();
    for (auto& s : p.servos)
        if (s.function == "pluck" && s.stringIndex == 0) {
            s.function = "strum";
            s.alternateDirection = true;
            s.activeAltUs = 0;                     // use the implicit mirror
            s.restUs = 600; s.activeUs = 2400;     // mirror = -1200 -> out of window
        }
    bool warned = false;
    for (const auto& is : ProfileValidator::validate(p))
        if (is.field.find("activeAltUs") != std::string::npos &&
            is.severity == ValidationIssue::Severity::Warning)
            warned = true;
    CHECK(warned);
    CHECK(ProfileValidator::isActivatable(p));  // warning only
}

// A raise-to-play strum lift holds its mute AT REST, so disableAtRest would cut the
// PWM that keeps it damping — the validator warns (still activatable) (audit P-B5).
TEST(validator_warns_raise_to_play_lift_disable_at_rest) {
    Profile p = uke();
    p.pluck.liftEngage = LiftEngage::RaiseToPlay;
    ServoConfig lift;
    lift.enabled = true;
    lift.function = "strumLift";
    lift.stringIndex = 0;
    lift.channel = 13;              // free channel on string 0's PCA board
    lift.disableAtRest = true;      // the flagged condition
    p.servos.push_back(lift);
    bool warned = false;
    for (const auto& is : ProfileValidator::validate(p))
        if (is.field.find("disableAtRest") != std::string::npos &&
            is.severity == ValidationIssue::Severity::Warning)
            warned = true;
    CHECK(warned);
    CHECK(ProfileValidator::isActivatable(p));  // warning only
}

TEST(validator_requires_striker_per_string) {
    Profile p = uke();
    // Remove all pluck servos: every string now lacks a striker (strumming is per
    // string, so this must fail — there is no shared strummer to fall back on).
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "pluck") it = p.servos.erase(it);
        else ++it;
    }
    CHECK(!ProfileValidator::isActivatable(p));
    // A per-string strum servo on each string satisfies the requirement.
    for (size_t i = 0; i < p.strings.size(); ++i) {
        ServoConfig strum;
        strum.enabled = true; strum.function = "strum";
        strum.stringIndex = static_cast<int8_t>(i);
        strum.channel = static_cast<uint8_t>(12 + i);
        p.servos.push_back(strum);
    }
    CHECK(ProfileValidator::isActivatable(p));
}

TEST(validator_limits_direct_servos_to_eight) {
    Profile p = uke();
    for (int i = 0; i < 9; ++i) {
        ServoConfig s; s.enabled = true; s.function = "aux"; s.stringIndex = -1;
        s.source = ServoSource::DirectGpio; s.gpio = -1;  // gpio conflict aside
        p.servos.push_back(s);
    }
    bool over = false;
    for (const auto& is : ProfileValidator::validate(p))
        if (is.field == "servos.direct") over = true;
    CHECK(over);
}

// --- MIDI P1 ghost note (chord buffer) ---

TEST(note_off_cancels_buffered_chord_note) {
    InstrumentController ic;
    ic.load(uke());
    ic.handleEvent(noteOn(0, 62, 100, 0), 0);   // buffered (automatic)
    ic.handleEvent(noteOff(0, 62, 1000), 1000); // off before the window flushes
    ic.tick(5000);                              // window elapsed
    CHECK_EQ(ic.soundingCount(), 0);            // no ghost note
}

// --- MIDI P1 occupied-string replacement (explicit selection) ---

TEST(explicit_replacement_on_same_string) {
    Profile p = uke();
    p.selector.mode = SelectionMode::Explicit;
    InstrumentController ic;
    ic.load(p);
    // First note on physical string index 2 (open 64), fret 5 -> note 69.
    ic.handleEvent(cc(0, 20, 3, 0), 0);
    ic.handleEvent(cc(0, 21, 5, 0), 0);
    ic.handleEvent(noteOn(0, 69, 100, 0), 0);
    CHECK(ic.target(2).active);
    uint32_t firstId = ic.target(2).commandId;
    // Second note reuses the SAME string (index 2), fret 7 -> note 71.
    ic.handleEvent(cc(0, 20, 3, 0), 0);
    ic.handleEvent(cc(0, 21, 7, 0), 0);
    ic.handleEvent(noteOn(0, 71, 100, 0), 0);
    CHECK(ic.target(2).commandId != firstId);
    // Note Off for the FIRST note must NOT stop the string (old mapping dropped).
    ic.handleEvent(noteOff(0, 69, 0), 0);
    CHECK(ic.target(2).active);
    // Note Off for the current note releases it.
    ic.handleEvent(noteOff(0, 71, 0), 0);
    CHECK(!ic.target(2).active);
}

// --- P1: a disabled axis never plays, even via explicit CC selection ---
TEST(disabled_axis_never_plays) {
    Profile p = uke();
    p.strings[0].enabled = false;
    p.selector.mode = SelectionMode::Explicit;
    InstrumentController ic;
    ic.load(p);
    ic.handleEvent(cc(0, 20, 1, 0), 0);   // string 1 -> physical index 0 (disabled)
    ic.handleEvent(cc(0, 21, 0, 0), 0);   // fret 0 -> note 67
    ic.handleEvent(noteOn(0, 67, 100, 0), 0);
    CHECK(!ic.target(0).active);          // refused
    CHECK_EQ(ic.soundingCount(), 0);
}

// --- P1: the selector is cleared on profile load / panic ---
TEST(selector_reset_clears_pending) {
    StringFretSelector sel;
    SelectorConfig cfg; cfg.mode = SelectionMode::Explicit;
    cfg.string.maximum = 4; cfg.fret.maximum = 12;
    sel.configure(cfg);
    InstrumentView v; v.stringCount = 4; v.openNotes = {67, 60, 64, 69};
    v.maxFretPerString = {12, 12, 12, 12};
    sel.setInstrument(v);
    sel.onControlChange(cc(0, 20, 3, 0));
    sel.onControlChange(cc(0, 21, 5, 0));
    CHECK(sel.pending().size() > 0);
    sel.reset();
    CHECK_EQ((int)sel.pending().size(), 0);
}

// --- P1: SysEx parser ignores real-time bytes and bounds the buffer ---
TEST(sysex_parser_ignores_realtime_and_bounds) {
    MidiParser p;
    // A real-time clock byte (0xF8) injected mid-SysEx must not enter the buffer.
    uint8_t msg[] = {0xF0, 0x7D, 0x00, 0xF8, 0x06, 0x01, 0xF7};
    p.feed(msg, sizeof(msg), 0);
    CHECK_EQ((int)p.sysex().size(), 1);
    CHECK_EQ((int)p.sysex()[0].size(), 6);  // 0xF8 dropped: F0 7D 00 06 01 F7
    for (uint8_t b : p.sysex()[0]) CHECK(b != 0xF8);

    // An unterminated oversized SysEx is aborted, not buffered without bound.
    MidiParser q;
    q.feed(0xF0, 0);
    for (size_t i = 0; i < MidiParser::kMaxSysExBytes + 100; ++i) q.feed(0x01, 0);
    CHECK_EQ((int)q.sysex().size(), 0);  // never completed, buffer released
}

// --- P0: a runtime-faulted axis is removed from the allocator ---
TEST(faulted_string_removed_from_allocation) {
    InstrumentController ic;
    ic.load(uke());              // GCEA: 67,60,64,69
    ic.faultString(0);           // take string 0 (G) out of service
    // A full open chord: 60->s1, 64->s2, 69->s3; 67 can only go on s0 (faulted)
    // -> dropped. So exactly 3 sound and string 0 stays inactive.
    ic.handleEvent(noteOn(0, 67, 100, 0), 0);
    ic.handleEvent(noteOn(0, 60, 100, 0), 0);
    ic.handleEvent(noteOn(0, 64, 100, 0), 0);
    ic.handleEvent(noteOn(0, 69, 100, 0), 0);
    ic.tick(5000);
    CHECK(!ic.target(0).active);
    CHECK_EQ(ic.soundingCount(), 3);
}

// recoverString undoes a runtime fault so the axis can play again (reset path).
TEST(recover_string_restores_a_faulted_axis) {
    InstrumentController ic;
    ic.load(uke());
    ic.faultString(2);                       // string 2 out of service
    CHECK(ic.string(2).state() == StringState::Fault);
    ic.recoverString(2);                     // reset recovery
    CHECK(ic.string(2).state() == StringState::Idle);
    // And it is choosable again: an explicit note on string 2 plays.
    Profile p = uke();
    p.selector.mode = SelectionMode::Explicit;
    p.selector.prepareOnCompleteSelection = false;
    InstrumentController ic2;
    ic2.load(p);
    ic2.faultString(2);
    ic2.recoverString(2);
    ic2.handleEvent(cc(0, 20, 3, 0), 0);     // string index 2
    ic2.handleEvent(cc(0, 21, 5, 0), 0);
    ic2.handleEvent(noteOn(0, 69, 100, 0), 0);
    CHECK(ic2.target(2).active);
}

// --- P0: degraded capabilities exclude the faulted axis entirely ---
TEST(degraded_snapshot_excludes_disabled_string) {
    Profile p = Profile::makeDefault("Guitar", 6, {40, 45, 50, 55, 59, 64}, 12);
    CapabilitySnapshot full = buildSnapshot(p);
    CHECK_EQ((int)full.stringConfig.stringCount, 6);
    CHECK_EQ((int)full.stringConfig.tuning.size(), 6);

    p.strings[0].enabled = false;  // low E axis failed homing (runtime copy)
    CapabilitySnapshot deg = buildSnapshot(p);
    CHECK_EQ((int)deg.stringConfig.stringCount, 5);
    CHECK_EQ((int)deg.stringConfig.tuning.size(), 5);
    CHECK_EQ((int)deg.stringConfig.fretsPerString.size(), 5);
    CHECK_EQ((int)deg.capabilities.polyphony, 5);
    CHECK_EQ((int)deg.capabilities.noteMin, 45);  // low E gone -> A2 is the floor
}

// --- P0: a faulted axis survives a panic (not resurrected to Idle) ---
TEST(panic_preserves_faulted_axis) {
    InstrumentController ic;
    ic.load(uke());
    ic.faultString(1);
    CHECK(ic.string(1).state() == StringState::Fault);
    ic.panic();                                   // CC120 / Wi-Fi loss path
    CHECK(ic.string(1).state() == StringState::Fault);
    // A disabled axis likewise stays disabled through a panic.
    Profile p = uke();
    p.strings[0].enabled = false;
    InstrumentController ic2;
    ic2.load(p);
    CHECK(ic2.string(0).state() == StringState::Disabled);
    ic2.panic();
    CHECK(ic2.string(0).state() == StringState::Disabled);
}

// --- P0/P1: a disabled string does not require a striker servo ---
TEST(disabled_string_not_required_in_validation) {
    Profile p = Profile::makeDefault("Guitar", 6, {40, 45, 50, 55, 59, 64}, 12);
    p.strings[5].enabled = false;
    // Remove the disabled string's pluck servo: it must still validate.
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "pluck" && it->stringIndex == 5) it = p.servos.erase(it);
        else ++it;
    }
    CHECK(ProfileValidator::isActivatable(p));  // disabled string is exempt
}

// --- P1: the announced sustain CC follows the configured value ---
TEST(sustain_cc_announced_from_config) {
    Profile p = uke();
    p.midi.sustainPedal = true;
    p.midi.sustainCc = 66;
    CapabilitySnapshot s = buildSnapshot(p);
    bool has66 = false, has64 = false;
    for (uint8_t cc : s.capabilities.supportedCc) {
        if (cc == 66) has66 = true;
        if (cc == 64) has64 = true;
    }
    CHECK(has66);
    CHECK(!has64);
}

// --- selection spec: fret-then-string CC order ---

TEST(fret_before_string_cc_order) {
    StringFretSelector sel;
    SelectorConfig cfg;
    cfg.mode = SelectionMode::Explicit;
    cfg.string.maximum = 4;
    cfg.fret.maximum = 12;
    sel.configure(cfg);
    InstrumentView v;
    v.stringCount = 4; v.openNotes = {67, 60, 64, 69};
    v.maxFretPerString = {12, 12, 12, 12};
    sel.setInstrument(v);

    // Fret arrives BEFORE the string this time.
    sel.onControlChange(cc(0, 21, 5, 0));  // fret 5
    sel.onControlChange(cc(0, 20, 3, 0));  // string 3 -> index 2
    NoteResolution r = sel.onNoteOn(noteOn(0, 69, 100, 0), 1);
    CHECK(r.play);
    CHECK(r.source == ResolveSource::Explicit);
    CHECK_EQ((int)r.stringIndex, 2);
    CHECK_EQ((int)r.fret, 5);
    CHECK_EQ((int)sel.pending().size(), 0);  // exactly one selection consumed
}

// SX-5: a signed CC offset outside the SysEx-encodable band (-64..63) is rejected.
TEST(validator_rejects_cc_offset_out_of_band) {
    Profile p = uke();
    p.selector.string.offset = 100;  // > 63
    CHECK(!ProfileValidator::isActivatable(p));
    Profile q = uke();
    q.selector.fret.offset = -100;   // < -64
    CHECK(!ProfileValidator::isActivatable(q));
}

// --- MIDI robustness (M-C / M-E / M-G) ---

static void setupSel(StringFretSelector& sel) {
    SelectorConfig cfg;
    cfg.mode = SelectionMode::Explicit;
    cfg.selectionTimeoutMs = 100;
    cfg.string.minimum = 1; cfg.string.maximum = 4;
    cfg.fret.minimum = 0; cfg.fret.maximum = 12;
    sel.configure(cfg);
    InstrumentView v;
    v.stringCount = 4; v.openNotes = {67, 60, 64, 69};
    v.maxFretPerString = {12, 12, 12, 12};
    sel.setInstrument(v);
}

// M-C: an expired older selection must not shadow a newer, still-valid one.
TEST(expired_selection_does_not_shadow_newer_valid) {
    StringFretSelector sel;
    setupSel(sel);
    sel.onControlChange(cc(0, 20, 1, 0));       // A @0: string 1 (idx 0)
    sel.onControlChange(cc(0, 21, 0, 0));       // A: fret 0   (expires @100ms)
    sel.onControlChange(cc(0, 20, 3, 50000));   // B @50: string 3 (idx 2)
    sel.onControlChange(cc(0, 21, 5, 50000));   // B: fret 5   (expires @150ms)
    // @120ms: A is expired, B is still valid -> B must be chosen, not A.
    NoteResolution r = sel.onNoteOn(noteOn(0, 69, 100, 120000), 120000);
    CHECK(r.play);
    CHECK(r.source == ResolveSource::Explicit);
    CHECK_EQ((int)r.stringIndex, 2);
    CHECK_EQ((int)r.fret, 5);
}

// M-E: an invalid string CC binds the waiting fret as invalid so a LATER valid
// string can't mis-pair it; the invalid selection routes through the policy.
TEST(invalid_string_cc_does_not_orphan_fret) {
    StringFretSelector sel;
    setupSel(sel);  // fret.invalidValuePolicy defaults to AutomaticFallback
    sel.onControlChange(cc(0, 21, 5, 0));    // fret 5 first (fret-only pending)
    sel.onControlChange(cc(0, 20, 99, 0));   // INVALID string -> binds fret as invalid
    sel.onControlChange(cc(0, 20, 2, 0));    // valid string 2 -> its OWN new pending
    // The oldest complete selection is the invalid one -> policy (fallback), NOT a
    // mis-paired string2+fret5 explicit note.
    NoteResolution r = sel.onNoteOn(noteOn(0, 69, 100, 0), 0);
    CHECK(r.source != ResolveSource::Explicit);  // not the mis-paired pair
}

// M-G: the CC offset is applied BEFORE the range check, so a value whose LOGICAL
// result is in range is accepted (and a raw-but-out-of-logical-range one is not).
TEST(cc_offset_applied_before_validation) {
    StringFretSelector sel;
    SelectorConfig cfg;
    cfg.mode = SelectionMode::Explicit;
    cfg.string.minimum = 1; cfg.string.maximum = 4; cfg.string.offset = -4;  // sends 5..8
    cfg.fret.maximum = 12;
    sel.configure(cfg);
    InstrumentView v;
    v.stringCount = 4; v.openNotes = {67, 60, 64, 69};
    v.maxFretPerString = {12, 12, 12, 12};
    sel.setInstrument(v);
    CHECK_EQ(sel.mapStringValue(5), 0);   // 5-4 = logical 1 -> index 0
    CHECK_EQ(sel.mapStringValue(8), 3);   // 8-4 = logical 4 -> index 3
    CHECK_EQ(sel.mapStringValue(1), -1);  // 1-4 = logical -3 -> rejected
    CHECK_EQ(sel.mapStringValue(9), -1);  // 9-4 = logical 5 -> out of [1,4]
}
