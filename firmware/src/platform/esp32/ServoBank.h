// Servo bank supporting PCA9685 AND direct-GPIO servos, mixable per servo (user
// requirement: work with or without a PCA). Boards live on one or BOTH of the
// ESP32-S3's two hardware I2C controllers (Wire = bus 0, Wire1 = bus 1), up to
// eight boards per bus (0x40..0x47); splitting boards over two buses halves the
// traffic. Roles: finger / pluck / strum / strumLift / damper per string, plus a
// shared damper and aux actuators. There is no shared strummer — strumming is per
// string. The PCA /OE line(s) are tied to a safety pin (one shared, or one per bus)
// so all PCA servos can be neutralised instantly (spec §21.2); direct servos are
// detached on stop.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../../core/configuration/Profile.h"
#include "../../core/instrument/ActuatorResult.h"

#if defined(ARDUINO)
#include <Adafruit_PWMServoDriver.h>
#include <Arduino.h>
#include <Wire.h>
#endif

namespace gmb {

class ServoBank {
public:
    static constexpr int kMaxPca = gmb::kMaxPca;  // 0x40..0x47 (up to 8 boards)

    // Bus 0 uses (sda/scl) on Wire and oePin for /OE. A second I2C bus (Wire1) is
    // brought up when any board sits on i2cBus 1: (sda2/scl2) drive it and oePin2 is
    // its /OE — pass oePin2 = -1 to share the single /OE line across both buses. Any
    // pin may be -1 when unused (e.g. no PCA at all — every servo on a direct GPIO).
    void begin(const std::vector<ServoConfig>& servos, int8_t sda, int8_t scl,
               int8_t oePin, int8_t sda2 = -1, int8_t scl2 = -1, int8_t oePin2 = -1);

    // Low-level "just write" primitives (no result; used internally + by tests).
    void toRest(int index);
    void toActive(int index);
    void toMicros(int index, uint16_t us);

    // Scheduler-facing motion API (audit P1.4). Every one returns an ActuatorResult
    // so the playback scheduler ALWAYS knows whether the command reached the hardware
    // and, on failure, why — no more bool-here / void-there. They stay non-blocking
    // and honour travelMs / settleMs / disableAtRest.
    //   press   : hold active (finger down / strum lift engaged)
    //   pressFret: press the finger toward the side that frets `fret` — activeUs for
    //              side A / a plain finger, activeBUs for a geared side-B fret
    //   release : return to rest (finger up); update() cuts idle PWM if disableAtRest
    //   strike  : pulse active then auto-return to rest (pluck / strum / damper);
    //             intensity 0..1 scales the strike depth (velocity)
    //   mute    : drive a plucker to its muteUs (rest against the string) and HOLD;
    //             returns Disabled when the servo has no mute position (muteUs == 0)
    //   moveTo  : drive to an exact pulse and HOLD (calibration preview); the pulse
    //             is clamped to the servo's calibrated window
    ActuatorResult press(int index);
    ActuatorResult pressFret(int index, int fret);
    ActuatorResult release(int index);
    ActuatorResult strike(int index, double intensity = 1.0);
    ActuatorResult mute(int index);
    ActuatorResult moveTo(int index, uint16_t us);
    // Advance scheduled returns and rest-time PWM cut-off. Call from loop().
    void update(uint32_t nowMs);

    // Hardware safety: enable/disable all PCA outputs via /OE.
    void outputEnable(bool on);

    // Immediate HARD STOP (E-stop / panic / major hardware fault): PCA /OE OFF and
    // direct-GPIO PWM OFF at once, no mechanical wait, all runtime state cleared.
    // This must never depend on a mechanical movement completing first (spec P0 §21.2).
    void hardStop();

    // Controlled park, phase 1: command every servo to its REST position with the
    // outputs kept ENABLED (fingers up, strikers home). Non-blocking — the caller
    // times the travel with parkDurationMs(), then either arms (keep outputs live) or
    // calls hardStop() to cut power once the servos have settled (normal stop /
    // profile change / reconfiguration).
    void moveAllToRest();

    // Longest mechanical settle across all enabled servos: max(travelMs + settleMs).
    // The wait a controlled park / arming must allow after moveAllToRest() before the
    // servos are guaranteed home.
    uint32_t parkDurationMs() const;

    // Lookup by role + string (-1 for shared roles). Returns -1 if absent.
    int servoIndex(const std::string& function, int stringIndex) const;
    // Servo-per-fret: the finger servo pressing a SPECIFIC fret on a string. Fret 0
    // (open) never has one. Returns -1 if that fret carries no finger.
    int fingerIndexForFret(int stringIndex, int fret) const;
    // Estimated ms to sweep the finger at `index` from where it currently is to the
    // pulse that frets `fret`, scaled from travelMs by the real pulse distance. Lets
    // a direct geared sweep A<->B (skipping neutral) wait for its true motion; a
    // re-press of the same side returns ~0. See FingerTarget.h::fingerSweepMs.
    uint16_t sweepMsToFret(int index, int fret) const;
    // First finger of a string, if any (used to lift on shutdown / fault). Prefer
    // fingerIndexForFret for play; a string may have many fingers now.
    int fingerIndex(int stringIndex) const { return servoIndex("finger", stringIndex); }
    int pluckIndex(int stringIndex) const { return servoIndex("pluck", stringIndex); }
    int strumIndex(int stringIndex) const { return servoIndex("strum", stringIndex); }
    // Optional per-string lift that lowers (engages) the strum/pluck servo onto
    // the string for a stroke, then raises (disengages) it: rest = raised.
    int strumLiftIndex(int stringIndex) const { return servoIndex("strumLift", stringIndex); }
    int damperIndex(int stringIndex) const { return servoIndex("damper", stringIndex); }

    // True if any configured direct-GPIO servo failed to attach an LEDC channel.
    bool directAttachFault() const { return directAttachFault_; }
    // True if a referenced PCA9685 board did not respond on I2C.
    bool pcaAttachFault() const { return pcaAttachFault_; }
    // Runtime health probe: re-checks that every used PCA9685 still ACKs on I2C,
    // so a board unplugged AFTER arming is detected (returns true when no PCA is
    // used). Cheap enough to call a few times a second.
    bool pcaHealthy() const;
    // Same probe, but on failure reports WHICH board went silent as a bucket
    // (i2cBus*8 + board, matching board()) so the runtime can isolate just the
    // strings on that board instead of a global panic (audit P1.5). `failedBoard`
    // is only written when the result is false.
    bool pcaHealthy(uint8_t& failedBoard) const;
    // True if string `stringIndex` has at least one enabled servo on the PCA board
    // bucket `boardBucket` (i2cBus*8 + board) — used to map a lost board to the
    // exact strings it takes down.
    bool stringUsesBoard(int stringIndex, uint8_t boardBucket) const;
    // Human-readable "bus N / 0x4A" for a board bucket, for diagnostics/logs.
    static std::string boardName(uint8_t boardBucket);

    size_t count() const { return servos_.size(); }
    // True if `index` refers to a real, enabled servo that can actually be driven
    // (so a web servo-test can reject an invalid/disabled index instead of
    // silently succeeding).
    bool commandable(int index) const {
        return index >= 0 && index < static_cast<int>(servos_.size()) &&
               servos_[index].enabled;
    }
    bool usesPca() const { return pcaUsed_; }
    uint16_t travelMs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].travelMs : 0;
    }
    // Distinct physical PCA9685 board for a servo, as (i2cBus, pcaBoard) folded into
    // 0..15 — the bucket the activation governor caps per-board. 0xFF for a servo on
    // no board (direct GPIO), which the governor leaves out of any per-board window.
    uint8_t board(int index) const {
        if (index < 0 || index >= (int)servos_.size()) return 0xFF;
        const ServoConfig& s = servos_[index];
        return s.source == ServoSource::Pca
            ? static_cast<uint8_t>((s.i2cBus & 1) * 8 + (s.pcaBoard & 7)) : 0xFF;
    }
    uint16_t settleMs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].settleMs : 0;
    }
    // Extra pause after a strum lift is down before the stroke fires (strumLift).
    uint16_t engageDelayMs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].engageDelayMs : 0;
    }
    // Plectrum-as-mute pulse (0 = this servo has no mute-against-string position).
    uint16_t muteUs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].muteUs : 0;
    }

private:
    enum class Mode : uint8_t { Rest, Active, Striking };
    struct Rt {
        Mode mode = Mode::Rest;
        uint32_t returnAtMs = 0;  // when a strike returns to rest
        uint32_t restAtMs = 0;    // when a resting servo may cut its PWM
        bool pwmOff = false;
        bool strokeParity = false;  // toggles per strike for alternateDirection
        uint16_t lastUs = 0;        // last logical pulse commanded (pre-inversion)
    };
    std::vector<Rt> rt_;

    std::vector<ServoConfig> servos_;
    std::vector<int8_t> ledcCh_;  // LEDC channel per direct servo (Arduino 2.x)
    std::vector<bool> attached_;  // direct-servo LEDC attach state
    int8_t oePin_ = -1;
    int8_t oePin2_ = -1;          // /OE for the second I2C bus (-1 = shared with oePin_)
    int directCount_ = 0;         // number of LEDC channels handed out
    bool pcaUsed_ = false;
    bool pcaPresent_[2][kMaxPca] = {{false}};  // [i2cBus][board]
    bool directAttachFault_ = false;
    bool pcaAttachFault_ = false;
    static constexpr int kMaxDirectServos = 8;  // ESP32-S3 has 8 LEDC channels
#if defined(ARDUINO)
    // One driver per (bus, board): bus 0 on Wire, bus 1 on Wire1, each 0x40..0x47.
    // The "one PCA per string" convention puts a string's fret fingers + its plucker
    // on one board; boards can be spread over the two buses to cut I2C traffic.
    Adafruit_PWMServoDriver pca_[2][kMaxPca] = {
        {Adafruit_PWMServoDriver(0x40, Wire), Adafruit_PWMServoDriver(0x41, Wire),
         Adafruit_PWMServoDriver(0x42, Wire), Adafruit_PWMServoDriver(0x43, Wire),
         Adafruit_PWMServoDriver(0x44, Wire), Adafruit_PWMServoDriver(0x45, Wire),
         Adafruit_PWMServoDriver(0x46, Wire), Adafruit_PWMServoDriver(0x47, Wire)},
        {Adafruit_PWMServoDriver(0x40, Wire1), Adafruit_PWMServoDriver(0x41, Wire1),
         Adafruit_PWMServoDriver(0x42, Wire1), Adafruit_PWMServoDriver(0x43, Wire1),
         Adafruit_PWMServoDriver(0x44, Wire1), Adafruit_PWMServoDriver(0x45, Wire1),
         Adafruit_PWMServoDriver(0x46, Wire1), Adafruit_PWMServoDriver(0x47, Wire1)}};
#endif
    ActuatorResult writeMicros(int index, uint16_t us);  // Ok, or why it couldn't apply
    void writeOff(int index);
    bool attachDirect(int index);  // (re)attach a direct servo's LEDC channel
};

}  // namespace gmb
