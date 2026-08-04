// Instrument configuration profile (spec section 20).
//
// This is the single source of truth for the firmware. The web UI edits a draft
// which is validated and then atomically activated; SysEx capabilities and the
// runtime are rebuilt from the active profile only.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../board/PinManager.h"
#include "../instrument/NoteAllocator.h"
#include "../midi/StringFretSelector.h"
#include "StringConfig.h"

namespace gmb {

enum class NetworkMode : uint8_t { AccessPoint = 0, Station = 1 };

enum class VelocityCurve : uint8_t { Linear, Soft, Hard, Exponential, Custom };

struct InstrumentInfo {
    std::string name = "Instrument";
    std::string description;
    uint8_t stringCount = 4;
    std::string type = "guitar";
    uint8_t gmProgram = 24;   // GM 24 = nylon guitar
    uint8_t typeId = 0x04;    // GMB instrument type id (guitar)
    int8_t capo = 0;
    int8_t transpose = 0;
};

struct NetworkConfig {
    NetworkMode mode = NetworkMode::AccessPoint;
    std::string ssid;            // station SSID (never exported with password)
    std::string hostname = "gmb-instrument";
    std::string apSsid = "Servo-Plucked-Strings-GMB";
    bool staticIp = false;
};

struct MidiConfig {
    uint8_t globalChannel = 0;   // zero-based internal channel
    bool omni = false;
    int8_t transpose = 0;
    uint8_t chordWindowMs = 3;   // grouping window (spec 17.2)
    VelocityCurve velocityCurve = VelocityCurve::Linear;
    bool sustainPedal = true;
    uint8_t sustainCc = 64;
    SaturationStrategy saturationStrategy = SaturationStrategy::PriorityLow;

    // Playback timing / latency management.
    //   noteExecutionDelayMs : fixed delay between receiving a Note On and the
    //                          note actually sounding, so the mechanics have a
    //                          predictable, constant window to get in position.
    //   fingerLeadMs         : begin the finger descent up to this long before
    //                          the carriage is estimated to reach the fret, so
    //                          the finger arrives on the string around the same
    //                          time (overlaps descent with the approach).
    //   strumLeadMs          : begin lowering the strum lift up to this long
    //                          before the string is ready, so the strummer is
    //                          already engaged when the strike time comes.
    // The two leads shrink the minimum achievable noteExecutionDelayMs; both
    // default to 0 (no anticipation — the safe, strictly-sequential behaviour).
    uint16_t noteExecutionDelayMs = 0;
    uint16_t fingerLeadMs = 0;
    uint16_t strumLeadMs = 0;
};

// Where a servo's PWM signal comes from. The system must work with OR without a
// PCA9685 (a servo can hang directly off a free ESP32 GPIO), and both can be
// mixed on the same instrument.
enum class ServoSource : uint8_t { Pca = 0, DirectGpio = 1 };

// Servo roles. Per-string roles carry a stringIndex; shared roles use -1.
//   finger : presses the string at the fret            (per string)
//   pluck  : individual plectrum                       (per string)
//   strum  : per-string strum servo                    (per string)
//   strumLift : lowers/raises the strum servo per stroke (per string)
//   damper : per-string damper (mute)                  (per string)
//   sharedDamper : one damper mechanism across several strings
//   aux    : any auxiliary actuator
// (Strumming is per string only — there is no shared strummer role.)
// (Function is kept as a string so the web UI can offer new roles without a
// firmware change.)
struct ServoConfig {
    bool enabled = false;
    std::string function = "finger";
    int8_t stringIndex = -1;      // owning string, or -1 for a shared/global servo

    // For a "finger" servo: which fret this dedicated finger presses (1..kMaxFret).
    // -1 for every other role (pluck/strum/strumLift/damper/...). Fret positions
    // need not be contiguous — a string may carry fingers on frets {1,2,3,5,7,12}.
    int8_t fret = -1;

    // Signal source.
    ServoSource source = ServoSource::Pca;
    uint8_t pcaBoard = 0;         // 0..7 : up to eight PCA9685 (0x40..0x47)
    uint8_t channel = 0;          // PCA9685 channel 0..15 (source == Pca)
    int8_t gpio = -1;             // ESP32 GPIO           (source == DirectGpio)

    // Motion calibration (microseconds).
    uint16_t pulseMinUs = 500;
    uint16_t pulseMaxUs = 2500;
    uint16_t restUs = 1000;
    uint16_t activeUs = 1800;
    bool inverted = false;
    uint16_t travelMs = 120;
    uint16_t settleMs = 30;
    bool disableAtRest = true;

    // Strum / pluck stroke shaping.
    //   engageDelayMs      : for a strumLift, extra pause after the lift is down,
    //                        before the strum stroke fires (0 = none).
    //   alternateDirection : alternate the stroke endpoint on successive strikes
    //                        (down-stroke, up-stroke, down-stroke…).
    //   activeAltUs        : the up-stroke active pulse (0 = mirror activeUs about
    //                        restUs). Only used when alternateDirection is set.
    //   strokeMs           : time the stroke stays engaged before it returns to
    //                        rest (0 = use travelMs). Lets the stroke "speed" be
    //                        set independently of the return/settle timing.
    //   minStrikeUs        : guaranteed minimum strike depth toward the active side
    //                        so a low-velocity note still catches the string
    //                        (0 = disabled, depth follows velocity only).
    uint16_t engageDelayMs = 0;
    bool alternateDirection = false;
    uint16_t activeAltUs = 0;
    uint16_t strokeMs = 0;
    uint16_t minStrikeUs = 0;
};

// Servo current-draw management (limit PCA9685 overload). A servo is heaviest
// while it is actively driving toward a new position; a chord that re-frets many
// strings at once would stack those in-rush peaks. The scheduler asks a governor
// for a "start permit" before each press so no more than maxConcurrentMoves servos
// begin moving together, spaced by staggerMs. Combined with per-servo
// disableAtRest (idle fingers cut their PWM) and the release-before-press sequence
// (one finger per string at a time), this keeps the peak current bounded.
struct PowerConfig {
    uint8_t maxConcurrentMoves = 3;  // servos allowed to start moving at once
    uint16_t staggerMs = 8;          // spacing between successive start permits
};

struct Profile {
    std::string project = "Servo-Plucked-Strings-GMB";
    uint16_t profileVersion = 1;
    uint32_t capabilitiesRevision = 1;

    InstrumentInfo instrument;
    std::string boardIdentifier = "esp32-s3-devkitc-1";
    bool reserveUsb = true;
    bool automaticPinAssignment = true;
    std::vector<PinAssignment> pins;

    NetworkConfig network;
    MidiConfig midi;
    SelectorConfig selector;
    PowerConfig power;

    std::vector<StringConfig> strings;
    std::vector<ServoConfig> servos;

    // Build an InstrumentView (used by the selector and capabilities) from the
    // string list and the servo-derived available-fret masks.
    InstrumentView instrumentView() const;

    // Bit F set = string `stringIndex` has a finger servo for fret F (1..kMaxFret).
    // Fret 0 (open) is always playable and is NOT represented here. Derived from
    // the servo list, the single source of truth for which frets exist.
    uint32_t availableFretMask(size_t stringIndex) const;

    // Convenience: create a sensible default profile for a given instrument
    // (one finger servo per fret + one plucker per string, wired one PCA/string).
    static Profile makeDefault(const std::string& name, uint8_t stringCount,
                               const std::vector<uint8_t>& tuning, uint8_t maxFret);
};

}  // namespace gmb
