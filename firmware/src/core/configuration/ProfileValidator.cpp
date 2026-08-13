#include "ProfileValidator.h"

#include <utility>

#include "../Types.h"

namespace gmb {

using Sev = ValidationIssue::Severity;

// A single servo move / stroke / delay never legitimately takes this long; a value
// beyond it is a typo that would stall a note for tens of seconds (audit P-B3).
static constexpr uint16_t kMaxServoTimeMs = 5000;

std::vector<ValidationIssue> ProfileValidator::validate(const Profile& p) {
    std::vector<ValidationIssue> issues;
    auto err = [&](const std::string& f, const std::string& m) {
        issues.push_back({Sev::Error, f, m});
    };
    auto warn = [&](const std::string& f, const std::string& m) {
        issues.push_back({Sev::Warning, f, m});
    };

    // Capacity: 1..6 strings. Servo-per-fret has no stepper axis and no homing.
    if (p.instrument.stringCount < 1 || p.instrument.stringCount > kMaxStrings) {
        err("instrument.stringCount", "String count must be between 1 and 6");
    }
    if (p.strings.size() != p.instrument.stringCount) {
        err("strings", "Number of configured strings must equal the string count");
    }

    // The same signal name must not appear twice (an ambiguous SDA/SCL/... — the
    // pin resolver would silently take the last one).
    for (size_t a = 0; a < p.pins.size(); ++a)
        for (size_t b = a + 1; b < p.pins.size(); ++b)
            if (!p.pins[a].signal.empty() && p.pins[a].signal == p.pins[b].signal) {
                err("pins." + p.pins[a].signal, "Duplicate signal assignment");
                break;
            }

    auto hasPin = [&](const std::string& sig) {
        for (const auto& a : p.pins)
            if (a.signal == sig && a.gpio >= 0) return true;
        return false;
    };
    bool anyBus0 = false;
    bool anyBus1 = false;
    int directServos = 0;
    for (const auto& s : p.servos) {
        if (!s.enabled) continue;
        if (s.source == ServoSource::Pca) {
            if (s.i2cBus == 1) anyBus1 = true;
            else anyBus0 = true;
        } else {
            ++directServos;
        }
    }
    // Each I2C bus that actually carries a board needs its own SDA/SCL (an empty bus
    // needs nothing). Direct-GPIO servos carry their own pin in the servo entry
    // (validated below). There is no stepper ENABLE / STEP / DIR / HOME any more.
    if (anyBus0 && (!hasPin("SDA") || !hasPin("SCL")))
        err("pins.i2c", "SDA and SCL are required when a PCA9685 is on the primary I2C bus");
    if (anyBus1 && (!hasPin("SDA2") || !hasPin("SCL2")))
        err("pins.i2c2",
            "SDA2 and SCL2 are required when a PCA9685 is on the second I2C bus");
    // /OE safety line: shared (SERVO_OE) unless split per bus (SERVO_OE2). A board
    // relies on the shared line when it is on bus 0, or on bus 1 with no split OE2.
    bool needSharedOe = anyBus0 || (anyBus1 && !hasPin("SERVO_OE2"));
    if (needSharedOe && !hasPin("SERVO_OE"))
        err("pins.SERVO_OE", "The PCA9685 /OE safety pin is required");
    // ESP32-S3 has 8 LEDC channels; a direct servo consumes one.
    if (directServos > 8)
        err("servos.direct",
            "At most 8 direct-GPIO servos are supported (ESP32-S3 has 8 LEDC channels)");

    // Per-string sanity (pitch + fret ceiling only — no mechanical geometry).
    for (size_t i = 0; i < p.strings.size(); ++i) {
        const StringConfig& a = p.strings[i];
        std::string t = "strings[" + std::to_string(i) + "]";
        if (a.openNote > 127)
            err(t + ".openNote", "Open-string MIDI note must be 0..127");
        if (a.maxFret > kMaxFret)
            err(t + ".maxFret",
                "maxFret exceeds the maximum supported fret (" + std::to_string(kMaxFret) + ")");
    }

    // Pin validation on the reference board.
    if (const BoardProfile* board = builtinBoardProfile(p.boardIdentifier)) {
        PinManager pm(*board);
        pm.set(p.pins);
        for (const auto& e : pm.validate(p.reserveUsb)) {
            std::string msg = e.reason;
            if (!e.conflictWith.empty()) msg += " (used by " + e.conflictWith + ")";
            if (!e.suggestion.empty()) msg += " — " + e.suggestion;
            err("pins." + e.signal, msg);
        }
    } else {
        // A board we don't know is a hard error: no pin can be validated, so the
        // profile must not be activatable on this firmware.
        err("board", "Unknown board profile; pins cannot be validated");
    }

    // Servo configuration: PCA vs direct GPIO, with or without a PCA9685, plus the
    // servo-per-fret finger rules.
    {
        const BoardProfile* board = builtinBoardProfile(p.boardIdentifier);
        // Collect GPIOs already used (I2C/OE/etc.) so direct servos can't clash.
        std::vector<std::pair<int8_t, std::string>> usedGpio;
        for (const auto& a : p.pins)
            if (a.gpio >= 0) usedGpio.push_back({a.gpio, a.signal});

        std::vector<std::pair<int, int>> usedPcaChannels;   // (board, channel)
        std::vector<std::pair<int, int>> usedFingerFrets;   // (stringIndex, fret)
        // (stringIndex, roleGroup): pluck and strum share the "striker" group —
        // exactly one striker drives a string; strumLift and damper are unique too.
        std::vector<std::pair<int, std::string>> usedStringRoles;
        for (size_t i = 0; i < p.servos.size(); ++i) {
            const ServoConfig& s = p.servos[i];
            if (!s.enabled) continue;
            std::string tag = "servos[" + std::to_string(i) + "]";

            // Per-string roles must reference an existing string.
            bool perString = s.function == "finger" || s.function == "pluck" ||
                             s.function == "strum" || s.function == "strumLift" ||
                             s.function == "damper";
            if (perString) {
                if (s.stringIndex < 0 || s.stringIndex >= (int)p.strings.size())
                    err(tag + ".stringIndex",
                        "Per-string servo references a string that does not exist");
            }

            // Unique per-string actuators (audit): the runtime resolves each role by
            // FIRST match, so a duplicate pluck/strum/strumLift/damper — or a pluck
            // AND a strum on the same string — leaves one servo silently unused
            // while looking "valid". Block it so the wiring matches what plays.
            if (perString && s.function != "finger" && s.stringIndex >= 0) {
                std::string group =
                    (s.function == "pluck" || s.function == "strum") ? "striker"
                                                                     : s.function;
                std::pair<int, std::string> key{s.stringIndex, group};
                for (auto& u : usedStringRoles)
                    if (u == key)
                        err(tag + ".function",
                            group == "striker"
                                ? "String " + std::to_string(s.stringIndex) +
                                      " already has a pluck/strum servo — exactly one "
                                      "striker per string (the extra one would never "
                                      "be used)"
                                : "String " + std::to_string(s.stringIndex) +
                                      " already has a " + s.function +
                                      " servo — at most one per string (the extra one "
                                      "would never be used)");
                usedStringRoles.push_back(key);
            }

            // Finger servos carry a fret: it must be a real fret (1..kMaxFret), must
            // not exceed its string's maxFret, and must be unique per (string, fret)
            // so two servos never claim the same finger position.
            if (s.function == "finger") {
                // Validate one fret position of a finger (side A `fret`, or a geared
                // servo's side B `fretB`): real fret, reachable, and unique across
                // ALL finger positions so two servos never claim the same finger.
                auto checkFingerFret = [&](int fret, const std::string& field) {
                    if (fret < 1 || fret > (int)kMaxFret) {
                        err(tag + "." + field,
                            "A finger servo needs a fret in 1.." + std::to_string(kMaxFret) +
                                " (fret 0 is the open string and has no servo)");
                        return;
                    }
                    if (s.stringIndex >= 0 && s.stringIndex < (int)p.strings.size() &&
                        fret > (int)p.strings[s.stringIndex].maxFret)
                        warn(tag + "." + field,
                             "Finger fret exceeds the string's maxFret and is unreachable");
                    std::pair<int, int> key{s.stringIndex, fret};
                    for (auto& u : usedFingerFrets)
                        if (u == key)
                            err(tag + "." + field,
                                "String " + std::to_string(s.stringIndex) + " fret " +
                                    std::to_string(fret) + " already has a finger servo");
                    usedFingerFrets.push_back(key);
                };
                checkFingerFret(s.fret, "fret");

                // Geared / paired finger: this ONE servo also drives a SECOND fret
                // (side B) on the same string through a gear. The two frets must be
                // distinct and real, and side B needs its own in-window active pulse
                // (restUs stays the neutral, both-lifted position).
                if (s.fretB >= 0) {
                    if (s.fretB == s.fret)
                        err(tag + ".fretB",
                            "A geared finger's two frets must differ (side A == side B)");
                    else
                        checkFingerFret(s.fretB, "fretB");
                    if (s.activeBUs < s.pulseMinUs || s.activeBUs > s.pulseMaxUs)
                        err(tag + ".activeBUs",
                            "Side-B active pulse is outside the servo's min/max range");
                    // The neutral (restUs) is the both-fingers-lifted position and
                    // must sit strictly BETWEEN the two press pulses; otherwise
                    // "rest" leaves one side pressed on the string (audit P-B1,
                    // GEARED_FINGERS §5).
                    uint16_t glo = s.activeUs < s.activeBUs ? s.activeUs : s.activeBUs;
                    uint16_t ghi = s.activeUs < s.activeBUs ? s.activeBUs : s.activeUs;
                    if (s.restUs <= glo || s.restUs >= ghi)
                        err(tag + ".restUs",
                            "A geared finger's neutral (restUs) must lie strictly "
                            "between its side-A and side-B active pulses");
                }
            }

            if (s.pulseMinUs >= s.pulseMaxUs)
                err(tag + ".pulse", "pulseMinUs must be less than pulseMaxUs");
            // Absolute bounds: keep the pulse inside a sane hobby-servo window so a
            // stray value can't drive the actuator full-scale (the 50 Hz frame is
            // 20000 µs; real servos live well within ~200..3000 µs).
            if (s.pulseMinUs < 200)
                err(tag + ".pulseMinUs", "pulseMinUs is below the safe servo range (200 µs)");
            if (s.pulseMaxUs > 3000)
                err(tag + ".pulseMaxUs", "pulseMaxUs exceeds the safe servo range (3000 µs)");
            if (s.restUs < s.pulseMinUs || s.restUs > s.pulseMaxUs)
                err(tag + ".restUs", "Rest pulse is outside the servo's min/max range");
            if (s.activeUs < s.pulseMinUs || s.activeUs > s.pulseMaxUs)
                err(tag + ".activeUs", "Active pulse is outside the servo's min/max range");
            // A rest position identical to the active position can never actuate: a
            // finger would stay pressed forever (stuck note, breaks the one-finger-
            // per-string invariant), a plucker/strum would never strike (audit P-B1).
            if ((s.function == "finger" || s.function == "pluck" || s.function == "strum" ||
                 s.function == "strumLift" || s.function == "damper") &&
                s.restUs == s.activeUs)
                err(tag + ".activeUs",
                    "Rest and active pulses are identical — the servo cannot move");
            if (s.activeAltUs != 0 &&
                (s.activeAltUs < s.pulseMinUs || s.activeAltUs > s.pulseMaxUs))
                err(tag + ".activeAltUs",
                    "Alternate active pulse is outside the servo's min/max range");
            // An alternate endpoint equal to rest cannot strike: every second
            // stroke would not move at all (audit follow-up).
            if (s.alternateDirection && s.activeAltUs != 0 && s.activeAltUs == s.restUs)
                err(tag + ".activeAltUs",
                    "Alternate active pulse equals the rest pulse — every second "
                    "stroke would not move");
            // Alternate up-stroke with no explicit endpoint uses the implicit mirror
            // 2*rest-active; if that lands outside the pulse window it would be
            // clamped to a mechanical EXTREMITY — the plectrum sweeps far past its
            // calibrated geometry on every second stroke. That is a miscalibration,
            // not a preference: block activation until an explicit activeAltUs is
            // set (audit P-B7, upgraded from warning to error).
            if (s.alternateDirection && s.activeAltUs == 0) {
                int mirror = 2 * static_cast<int>(s.restUs) - static_cast<int>(s.activeUs);
                if (mirror < static_cast<int>(s.pulseMinUs) ||
                    mirror > static_cast<int>(s.pulseMaxUs))
                    err(tag + ".activeAltUs",
                        "Alternate up-stroke mirror (2*rest-active) is out of the pulse "
                        "window and would clamp to an extremity; set an explicit "
                        "activeAltUs (or disable alternateDirection)");
            }
            if (s.minStrikeUs != 0 &&
                (s.minStrikeUs < s.pulseMinUs || s.minStrikeUs > s.pulseMaxUs))
                err(tag + ".minStrikeUs",
                    "Minimum strike pulse is outside the servo's min/max range");
            // A minimum-strike pulse outside the rest->active stroke is almost
            // certainly a calibration slip: the runtime saturates the depth at the
            // stroke endpoint, so the intent is not what will play (audit 3, P2).
            if (s.minStrikeUs != 0) {
                uint16_t lo = s.restUs < s.activeUs ? s.restUs : s.activeUs;
                uint16_t hi = s.restUs < s.activeUs ? s.activeUs : s.restUs;
                if (s.minStrikeUs < lo || s.minStrikeUs > hi)
                    warn(tag + ".minStrikeUs",
                         "Minimum strike pulse lies outside the rest->active stroke; "
                         "the guaranteed depth saturates at the stroke endpoint");
            }
            // Plectrum-as-mute rest position, when set, must sit in the pulse window.
            if (s.muteUs != 0 && (s.muteUs < s.pulseMinUs || s.muteUs > s.pulseMaxUs))
                err(tag + ".muteUs",
                    "Mute pulse is outside the servo's min/max range");
            // A raise-to-play strum lift RESTS on the string — that rest position IS
            // the mute — so cutting its PWM at rest lets it drift off and the note
            // may not damp. disableAtRest must stay off for that servo (audit P-B5,
            // GEARED_FINGERS §8). The runtime forces this too, so it is a warning.
            if (s.function == "strumLift" && s.disableAtRest &&
                p.pluck.liftEngage == LiftEngage::RaiseToPlay)
                warn(tag + ".disableAtRest",
                     "A raise-to-play strum lift holds its mute at rest; disableAtRest "
                     "should be off so the plectrum keeps damping the string");
            // Timing sanity: a mis-typed motion time would stall a note for tens of
            // seconds while the FSM believes it is still moving/striking (audit P-B3).
            auto boundServoMs = [&](uint16_t v, const char* field) {
                if (v > kMaxServoTimeMs)
                    err(tag + "." + field,
                        std::string(field) + " exceeds the sane servo-timing bound (" +
                            std::to_string(kMaxServoTimeMs) + " ms)");
            };
            boundServoMs(s.travelMs, "travelMs");
            boundServoMs(s.settleMs, "settleMs");
            boundServoMs(s.strokeMs, "strokeMs");
            boundServoMs(s.engageDelayMs, "engageDelayMs");

            if (s.source == ServoSource::Pca) {
                if (s.pcaBoard > kMaxPca - 1)
                    err(tag + ".pcaBoard",
                        "PCA board index must be 0.." + std::to_string(kMaxPca - 1) +
                            " (max " + std::to_string(kMaxPca) + " PCA9685)");
                if (s.i2cBus > 1)
                    err(tag + ".i2cBus", "I2C bus must be 0 or 1");
                if (s.channel > 15)
                    err(tag + ".channel", "PCA channel must be 0..15");
                // A board is (bus, address): the same board+channel on DIFFERENT buses
                // is a different chip and allowed, so the bus is part of the key.
                int bus = s.i2cBus > 1 ? 1 : s.i2cBus;
                std::pair<int, int> key{bus * kMaxPca + s.pcaBoard, s.channel};
                for (auto& u : usedPcaChannels)
                    if (u == key)
                        err(tag + ".channel",
                            "PCA bus " + std::to_string(bus) + " board " +
                                std::to_string(s.pcaBoard) + " channel " +
                                std::to_string(s.channel) + " is already used by another servo");
                usedPcaChannels.push_back(key);
            } else {  // DirectGpio
                if (s.gpio < 0) {
                    err(tag + ".gpio", "Direct servo requires a GPIO");
                } else if (board && !board->supports(s.gpio, SignalKind::Generic)) {
                    err(tag + ".gpio",
                        "GPIO " + std::to_string(s.gpio) +
                            " cannot drive a servo on this board (reserved or output-incapable)");
                }
                for (auto& u : usedGpio)
                    if (u.first == s.gpio)
                        err(tag + ".gpio", "GPIO " + std::to_string(s.gpio) +
                                               " already used by " + u.second);
                if (s.gpio >= 0) usedGpio.push_back({s.gpio, tag});
            }
        }
    }

    // Striker / finger presence.
    {
        auto hasServoRole = [&](const std::string& fn, int strIdx) {
            for (const auto& s : p.servos)
                if (s.enabled && s.function == fn && s.stringIndex == strIdx) return true;
            return false;
        };
        // Strumming is per string: every enabled string needs its own striker —
        // a pluck (plectrum) or a strum servo. There is no shared strummer.
        for (size_t i = 0; i < p.strings.size(); ++i)
            if (p.strings[i].enabled &&
                !hasServoRole("pluck", static_cast<int>(i)) &&
                !hasServoRole("strum", static_cast<int>(i)))
                err("servos.pluck",
                    "String " + std::to_string(i) +
                        " needs a pluck or strum servo to be plucked");
        // A per-string strum lift only makes sense paired with a striker to lift.
        for (size_t i = 0; i < p.strings.size(); ++i)
            if (hasServoRole("strumLift", static_cast<int>(i)) &&
                !hasServoRole("pluck", static_cast<int>(i)) &&
                !hasServoRole("strum", static_cast<int>(i)))
                err("servos.strumLift",
                    "String " + std::to_string(i) +
                        " has a strum-lift servo but no pluck/strum servo to lift");
        // Plectrum-as-mute: if the global policy asks the plectrum to damp at Note
        // Off, a striker with no mute angle (muteUs == 0) can't — it degrades to a
        // damper or to no muting. Warn so a half-set instrument is visible, but do
        // not block (partial setups must still activate).
        if (p.pluck.muteSource == MuteSource::Plectrum) {
            auto strikerMuteUs = [&](int strIdx) -> int {
                for (const auto& s : p.servos)
                    if (s.enabled && s.stringIndex == strIdx &&
                        (s.function == "pluck" || s.function == "strum"))
                        return s.muteUs;
                return 0;
            };
            for (size_t i = 0; i < p.strings.size(); ++i)
                if (p.strings[i].enabled && strikerMuteUs(static_cast<int>(i)) == 0)
                    warn("pluck.muteSource",
                         "String " + std::to_string(i) +
                             " uses plectrum muting but its plucker has no mute angle "
                             "(muteUs) — it will not damp");
        }

        // Raise-to-play lift: a string with a plucker but no strum lift has nothing
        // to raise/lower — it silently falls back to the mute source. Warn (partial
        // setups must still activate).
        if (p.pluck.liftEngage == LiftEngage::RaiseToPlay) {
            for (size_t i = 0; i < p.strings.size(); ++i)
                if (p.strings[i].enabled &&
                    (hasServoRole("pluck", static_cast<int>(i)) ||
                     hasServoRole("strum", static_cast<int>(i))) &&
                    !hasServoRole("strumLift", static_cast<int>(i)))
                    warn("pluck.liftEngage",
                         "String " + std::to_string(i) +
                             " uses raise-to-play but has no strum lift — it will mute "
                             "via the fallback mute source instead");
        }

        // A fretted string that declares reachable frets but has no finger servo
        // can still play its open string safely (the allocator/selector only route
        // frets that carry a servo), so this is a warning, not a blocking error —
        // partial setups during installation must still activate.
        for (size_t i = 0; i < p.strings.size(); ++i)
            if (p.strings[i].enabled && p.strings[i].maxFret > 0 &&
                !hasServoRole("finger", static_cast<int>(i)))
                warn("servos.finger",
                     "String " + std::to_string(i) +
                         " declares frets (maxFret > 0) but has no finger servo — "
                         "only its open string can play");

        // At least one string must be enabled, otherwise the instrument can never
        // arm (it would sit in Boot with a bogus 0..0 capability range).
        size_t enabledStrings = 0;
        for (const auto& a : p.strings) if (a.enabled) ++enabledStrings;
        if (enabledStrings == 0)
            err("strings", "At least one string must be enabled");
    }

    // Servo current-draw governor. Each cap is optional (0 = no limit); a per-PCA
    // board never has more than its 16 channels moving at once.
    if (p.power.maxConcurrentPerBoard > 16)
        err("power.maxConcurrentPerBoard",
            "Per-board concurrent moves exceeds a PCA9685's 16 channels");
    if (p.power.staggerMs > 1000)
        err("power.staggerMs", "Servo start stagger exceeds a sane bound (1000 ms)");

    // Global timing sanity (audit P-B3): a huge value stalls notes for tens of
    // seconds. chordWindowMs is a small grouping window — a large one merges
    // unrelated notes into one chord, so it is only a warning.
    if (p.midi.noteExecutionDelayMs > kMaxServoTimeMs)
        err("midi.noteExecutionDelayMs", "Note-execution delay exceeds 5000 ms");
    if (p.midi.strumLeadMs > kMaxServoTimeMs)
        err("midi.strumLeadMs", "Strum lead exceeds 5000 ms");
    if (p.pluck.muteHoldMs > kMaxServoTimeMs)
        err("pluck.muteHoldMs", "Mute hold exceeds 5000 ms");
    if (p.pluck.fretToPluckMs > kMaxServoTimeMs)
        err("pluck.fretToPluckMs", "Fret-to-pluck delay exceeds 5000 ms");
    if (p.midi.chordWindowMs > 100)
        warn("midi.chordWindowMs", "Chord window over 100 ms may merge unrelated notes");

    // String/fret selection CC configuration (selection spec section 18). The
    // string/fret CCs are only consumed when selection is enabled and not in the
    // fully-automatic mode, so their range/collision rules only apply then — a
    // disabled selector must not fail a profile over its (unused) CC numbers.
    const SelectorConfig& s = p.selector;
    bool selectionActive = s.enabled && s.mode != SelectionMode::Automatic;
    if (selectionActive) {
        if (s.string.ccNumber > kMaxAssignableCc)
            err("selector.string.cc", "String CC must be 0..119 (120..127 are mode messages)");
        if (s.fret.ccNumber > kMaxAssignableCc)
            err("selector.fret.cc", "Fret CC must be 0..119 (120..127 are mode messages)");
        if (s.string.ccNumber == s.fret.ccNumber)
            err("selector.cc", "String and fret CC numbers must differ");
    }
    // CC7 (volume) and CC11 (expression) are consumed before selection/sustain,
    // so no consumed CC may collide with them or with each other. The string/fret
    // CCs join the set only when selection is active.
    {
        struct NamedCc { int cc; const char* field; };
        std::vector<NamedCc> ccs = {
            {7, "volume (CC7)"},
            {11, "expression (CC11)"},
        };
        if (selectionActive) {
            ccs.push_back({s.string.ccNumber, "selector.string.cc"});
            ccs.push_back({s.fret.ccNumber, "selector.fret.cc"});
        }
        if (p.midi.sustainPedal) ccs.push_back({p.midi.sustainCc, "midi.sustainCc"});
        for (size_t a = 0; a < ccs.size(); ++a)
            for (size_t b = a + 1; b < ccs.size(); ++b)
                if (ccs[a].cc == ccs[b].cc)
                    err("midi.ccCollision",
                        std::string("CC ") + std::to_string(ccs[a].cc) +
                            " is used by both " + ccs[a].field + " and " + ccs[b].field);
    }
    if (s.selectionTimeoutMs < 5 || s.selectionTimeoutMs > 2000)
        err("selector.timeout", "Selection timeout must be 5..2000 ms");
    if (s.queueDepth < 16 || s.queueDepth > 256)
        err("selector.queueDepth", "Selection queue depth must be 16..256");
    if (s.string.minimum > s.string.maximum)
        err("selector.string.range", "String CC minimum must be <= maximum");
    if (s.fret.minimum > s.fret.maximum)
        err("selector.fret.range", "Fret CC minimum must be <= maximum");
    // Signed CC offsets are transmitted as offset+64 over SysEx, so they must fit
    // the encodable band -64..63 (audit SX-5).
    if (s.string.offset < -64 || s.string.offset > 63)
        err("selector.string.offset", "String CC offset must be within -64..63");
    if (s.fret.offset < -64 || s.fret.offset > 63)
        err("selector.fret.offset", "Fret CC offset must be within -64..63");
    // Custom string mapping, when present, must be one entry per string, each
    // referencing a valid axis, AND a permutation (no axis used twice / skipped) —
    // otherwise a CC value would target a duplicate string while another becomes
    // unreachable (audit P1-11).
    if (!s.string.mapping.empty()) {
        if (s.string.mapping.size() != p.strings.size())
            err("selector.string.mapping", "Mapping must have one entry per string");
        std::vector<bool> seen(p.strings.size(), false);
        for (int8_t m : s.string.mapping) {
            if (m < 0 || m >= static_cast<int>(p.strings.size())) {
                err("selector.string.mapping", "Mapping references a non-existent string");
            } else if (seen[m]) {
                err("selector.string.mapping",
                    "Mapping must be a permutation (string " + std::to_string(m) +
                        " is used more than once)");
            } else {
                seen[m] = true;
            }
        }
    }

    // MIDI ranges.
    if (p.midi.sustainCc > kMaxAssignableCc)
        err("midi.sustainCc", "Sustain CC must be 0..119");
    if (p.instrument.capo < 0 || p.instrument.capo > 24)
        err("instrument.capo", "Capo must be 0..24");
    if (p.instrument.transpose < -48 || p.instrument.transpose > 48)
        err("instrument.transpose", "Transpose must be within +/-48 semitones");
    if (p.midi.transpose < -48 || p.midi.transpose > 48)
        err("midi.transpose", "MIDI transpose must be within +/-48 semitones");
    // Announced polyphony: 0 = automatic; a custom cap can never exceed the number
    // of physical strings (the snapshot also clamps it to the active count).
    if (p.instrument.polyphonyMax > kMaxStrings)
        err("instrument.polyphonyMax",
            "Polyphony must be 0 (automatic) or at most the string count");
    else if (p.instrument.polyphonyMax > p.instrument.stringCount)
        warn("instrument.polyphonyMax",
             "Polyphony exceeds the string count and will be clamped");
    // A name over 32 chars is truncated on the SysEx identity/capabilities wire (the
    // v2 descriptor carries it in full) — warn so the short announced name is not a
    // surprise (audit SX-6).
    if (p.instrument.name.size() > 32)
        warn("instrument.name",
             "Name longer than 32 characters is truncated on the SysEx wire");
    // Enum-backed fields must be within their defined range: a JSON import does a
    // static_cast, so an out-of-range value would reach a switch and hit an
    // unintended default (audit P1-10).
    auto enumOk = [&](int v, int maxInclusive, const std::string& field) {
        if (v < 0 || v > maxInclusive) err(field, "Value is out of range");
    };
    enumOk(static_cast<int>(p.midi.velocityCurve), 4, "midi.velocityCurve");
    enumOk(static_cast<int>(p.midi.saturationStrategy), 5, "midi.saturationStrategy");
    enumOk(static_cast<int>(p.pluck.muteSource), 4, "pluck.muteSource");
    enumOk(static_cast<int>(p.pluck.liftEngage), 1, "pluck.liftEngage");
    if (p.pluck.minStrikePct > 100)
        err("pluck.minStrikePct", "Minimum strike depth must be 0..100 %");
    enumOk(static_cast<int>(p.selector.mode), 2, "selector.mode");
    enumOk(static_cast<int>(p.selector.notePositionPolicy), 2, "selector.notePositionPolicy");
    enumOk(static_cast<int>(p.selector.fret.invalidValuePolicy), 3, "selector.fret.invalidValuePolicy");
    enumOk(static_cast<int>(p.selector.missingSelectionPolicy), 3, "selector.missingSelectionPolicy");
    enumOk(static_cast<int>(p.selector.expiredSelectionPolicy), 3, "selector.expiredSelectionPolicy");

    // Fret CC max should not exceed the instrument's playable frets.
    uint8_t maxFret = 0;
    for (const auto& a : p.strings) maxFret = a.maxFret > maxFret ? a.maxFret : maxFret;
    if (s.fret.maximum > maxFret)
        warn("selector.fret.maximum", "Fret CC maximum exceeds the instrument's frets");
    if (s.string.maximum > p.strings.size())
        warn("selector.string.maximum", "String CC maximum exceeds the string count");

    // MIDI.
    if (!p.midi.omni && p.midi.globalChannel > 15)
        err("midi.channel", "MIDI channel must be 0..15");

    // Profiles requirement.
    if (p.capabilitiesRevision == 0)
        warn("capabilitiesRevision", "Revision counter should start at 1");

    return issues;
}

}  // namespace gmb
