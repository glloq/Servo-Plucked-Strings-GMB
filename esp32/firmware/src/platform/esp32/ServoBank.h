// Servo bank supporting PCA9685 (up to four boards) AND direct-GPIO servos,
// mixable per servo (user requirement: work with or without a PCA). Roles:
// finger / pluck / strum / strumLift / damper per string, plus a shared damper
// and aux actuators. There is no shared strummer — strumming is per string.
// The PCA /OE line is tied to a safety pin so all PCA servos can be neutralised
// instantly (spec §21.2); direct servos are detached on stop.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../../core/configuration/Profile.h"

#if defined(ARDUINO)
#include <Adafruit_PWMServoDriver.h>
#include <Arduino.h>
#endif

namespace gmb {

class ServoBank {
public:
    static constexpr int kMaxPca = gmb::kMaxPca;  // 0x40..0x47 (up to 8 boards)

    // sda/scl select the I2C pins; oePin drives /OE (active-low). Any of them may
    // be -1 when unused (e.g. no PCA at all — all servos on direct GPIO).
    void begin(const std::vector<ServoConfig>& servos, int8_t sda, int8_t scl,
               int8_t oePin);

    void toRest(int index);
    void toActive(int index);
    void toMicros(int index, uint16_t us);
    // Drive a servo to an exact pulse and HOLD it (marks it active so the rest-time
    // PWM cut-off never releases it mid-test). Used by the calibration wizard to
    // preview any angle live, including a geared finger's side-B press. Returns
    // false if the servo could not be driven.
    bool holdMicros(int index, uint16_t us);

    // Non-blocking motion helpers (honour travelMs / settleMs / disableAtRest):
    //   press  : hold active   (finger down)
    //   release: return to rest (finger up), then optionally cut PWM at rest
    //   strike : pulse active then auto-return to rest (pluck / strum / damper)
    // Returns false if the servo could not actually be driven (LEDC re-attach or
    // PCA write failure) so the caller can fault the axis (audit P1-5).
    bool press(int index);
    // Geared fingers: press the finger at `index` toward the SIDE that frets `fret`
    // (activeUs for side A / a plain finger, activeBUs for a geared side-B fret).
    // Same return contract as press().
    bool pressFret(int index, int fret);
    void release(int index);
    // intensity 0..1 scales the strike depth between rest and active (velocity).
    void strike(int index, double intensity = 1.0);
    // Advance scheduled returns and rest-time PWM cut-off. Call from loop().
    void update(uint32_t nowMs);

    // Hardware safety: enable/disable all PCA outputs via /OE.
    void outputEnable(bool on);
    void neutraliseAll();

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
    uint16_t settleMs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].settleMs : 0;
    }
    // Extra pause after a strum lift is down before the stroke fires (strumLift).
    uint16_t engageDelayMs(int index) const {
        return (index >= 0 && index < (int)servos_.size()) ? servos_[index].engageDelayMs : 0;
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
    int directCount_ = 0;         // number of LEDC channels handed out
    bool pcaUsed_ = false;
    bool pcaPresent_[kMaxPca] = {false};
    bool directAttachFault_ = false;
    bool pcaAttachFault_ = false;
    static constexpr int kMaxDirectServos = 8;  // ESP32-S3 has 8 LEDC channels
#if defined(ARDUINO)
    // One driver per board at 0x40 + index (up to eight boards). The "one PCA per
    // string" wiring convention puts a string's fret fingers + its plucker on one.
    Adafruit_PWMServoDriver pca_[kMaxPca] = {
        Adafruit_PWMServoDriver(0x40), Adafruit_PWMServoDriver(0x41),
        Adafruit_PWMServoDriver(0x42), Adafruit_PWMServoDriver(0x43),
        Adafruit_PWMServoDriver(0x44), Adafruit_PWMServoDriver(0x45),
        Adafruit_PWMServoDriver(0x46), Adafruit_PWMServoDriver(0x47)};
#endif
    bool writeMicros(int index, uint16_t us);  // false if the write couldn't apply
    void writeOff(int index);
    bool attachDirect(int index);  // (re)attach a direct servo's LEDC channel
};

}  // namespace gmb
