// SafetySupervisor (audit P2.17): the arming / parking / hard-stop / panic / runtime-
// fault operations, lifted out of main.cpp so the P0 safety sequence lives in one named
// unit instead of a scatter of free functions in the sketch.
//
// It OWNS no state. Every collaborator — the SafetyManager, the actuator stack
// (ServoBank / InstrumentController / PlaybackScheduler / ActuatorManager), the shared
// app phase, the degraded flag, the per-string fault vector, the E-stop pin and the
// active profile — is injected by reference through bind(), and the three cross-domain
// steps (rebuild capabilities, notify capabilities changed, and the hard-stop cleanup of
// scheduled test-notes + a pending profile swap) are injected as callbacks. So the
// storage and every existing reader in main.cpp stay exactly where they are: only the
// operation BODIES moved here, unchanged, and main.cpp's free functions became thin
// delegates so every call site is byte-identical.
//
// Arduino-gated (it drives ServoBank / PlaybackScheduler): compile-checked by hostcheck,
// NOT host-unit-tested. Behaviour is preserved by construction (verbatim bodies); like
// every mechanical path in this repo it is to be RE-VALIDATED on the bench, not assumed
// correct because the software builds.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "../../core/app/AppPhase.h"
#include "../../core/configuration/Profile.h"
#include "../../core/configuration/ProfileValidator.h"
#include "../../core/instrument/ActuatorManager.h"
#include "../../core/instrument/ActuatorResult.h"
#include "../../core/instrument/InstrumentController.h"
#include "../../core/safety/SafetyManager.h"
#include "PlaybackScheduler.h"
#include "ServoBank.h"

#if defined(ARDUINO)
#include <Arduino.h>  // digitalRead / millis / LOW
#endif

namespace gmb {

class SafetySupervisor {
public:
    struct Deps {
        SafetyManager* safety = nullptr;
        ServoBank* servos = nullptr;
        InstrumentController* instrument = nullptr;
        PlaybackScheduler* scheduler = nullptr;
        ActuatorManager* actuators = nullptr;
        AppPhase* phase = nullptr;
        bool* degraded = nullptr;
        std::vector<bool>* stringFaulted = nullptr;
        int8_t* estopPin = nullptr;
        bool* estopNc = nullptr;  // NC contact: stop when the pin reads HIGH (loop open)
        Profile* profile = nullptr;
        std::function<int()> rebuildCaps;       // -> working string count (rebuildRuntimeCapabilities)
        std::function<void()> notifyCaps;       // notifyCapabilitiesChanged
        std::function<void()> hardStopCleanup;  // clear scheduled test-notes + cancel a pending swap
    };
    void bind(const Deps& d) { d_ = d; }

    bool locked() const {
        SafetyState s = d_.safety->state();
        return s == SafetyState::Panic || s == SafetyState::EmergencyStop;
    }

    // Raw E-stop level, honouring the contact wiring: a normally-open button stops
    // on LOW (legacy active-low); the recommended normally-closed loop stops on
    // HIGH — a press, a cut wire or an unplugged connector all open the loop.
    bool estopAsserted() const {
        int8_t pin = d_.estopPin ? *d_.estopPin : int8_t(-1);
        if (pin < 0) return false;
        bool nc = d_.estopNc && *d_.estopNc;
        return nc ? digitalRead(pin) == HIGH : digitalRead(pin) == LOW;
    }

    // Begin the arming sequence (spec §13/§21, P0): validate, then PARK every servo at
    // rest with outputs live and wait the mechanical settle before declaring Ready.
    // Only STARTS parking (phase -> Parking); serviceParking() finishes it. Verbatim
    // from the old armInstrument().
    bool arm(uint32_t nowMs) {
        SafetyManager& g_safety = *d_.safety;
        ServoBank& g_servos = *d_.servos;
        InstrumentController& g_instrument = *d_.instrument;
        PlaybackScheduler& g_scheduler = *d_.scheduler;
        ActuatorManager& g_actuators = *d_.actuators;
        AppPhase& g_phase = *d_.phase;
        bool& g_degraded = *d_.degraded;
        Profile& g_profile = *d_.profile;

        if (locked()) return false;
        if (estopAsserted()) {
            g_safety.emergencyStop(nowMs);
            return false;
        }
        if (!ProfileValidator::isActivatable(g_profile)) return false;
        if (g_servos.directAttachFault() || g_servos.pcaAttachFault()) {
            g_safety.recordFault("attach", "a servo/PCA9685 could not attach or respond", nowMs);
            return false;
        }
        // Live PCA probe BEFORE parking (audit 7 P1): the periodic health check only
        // runs in Ready, so a board lost while stopped/reconfiguring would otherwise
        // be discovered only after the park was already trusted.
        {
            uint8_t failedBoard = 0xFF;
            if (!g_servos.pcaHealthy(failedBoard)) {
                g_safety.recordFault("park", "PCA9685 not responding (" +
                                     ServoBank::boardName(failedBoard) +
                                     ") — arming refused", nowMs);
                return false;
            }
        }
        g_safety.reset();  // -> PowerOnSafe (clean slate before parking)
        g_degraded = false;
        g_actuators.reset();
        for (size_t i = 0; i < g_profile.strings.size(); ++i) {
            if (!g_profile.strings[i].enabled)
                g_instrument.string(i).disable();  // a disabled string never plays
        }
        g_scheduler.clearCurrentFingers();
        g_servos.outputEnable(true);
        // A park is only as good as its commands: a refused rest write means a
        // finger may still be down, so arming must NOT proceed on hope (audit 7 P1).
        ServoBank::ParkResult park = g_servos.moveAllToRest();
        if (!park.ok) {
            g_safety.recordFault("park", "rest command refused by servo " +
                                 std::to_string(park.failedServo) + " [" +
                                 actuatorResultName(park.reason) + "] — arming aborted",
                                 nowMs);
            g_servos.hardStop();  // outputs back to the safe cut
            return false;
        }
        uint32_t parkMs = g_servos.parkDurationMs();
        if (!g_safety.beginParking(true, true, parkMs, nowMs)) return false;
        g_phase = AppPhase::Parking;
        return true;
    }

    // Finish arming: once the mechanical settle has elapsed, Parking -> Ready —
    // but only after a FINAL PCA health probe (audit 7 P1): a board that died
    // during the park means the rest positions cannot be trusted, so the arm
    // fails safe (hard stop + panic) instead of declaring Ready over servos that
    // may never have moved.
    void serviceParking(uint32_t nowMs) {
        AppPhase& g_phase = *d_.phase;
        SafetyManager& g_safety = *d_.safety;
        if (g_phase != AppPhase::Parking) return;
        if (!g_safety.tickParking(nowMs)) return;  // mechanical settle still running
        uint8_t failedBoard = 0xFF;
        if (!d_.servos->pcaHealthy(failedBoard)) {
            g_safety.recordFault("park", "PCA9685 lost during parking (" +
                                 ServoBank::boardName(failedBoard) +
                                 ") — park unconfirmed", nowMs);
            hardStop();
            g_safety.panic("parking could not be confirmed", nowMs);
            return;
        }
        g_phase = AppPhase::Ready;  // Armed
    }

    // Explicit recovery after a panic / E-stop. Verbatim from the old doReset().
    bool reset(uint32_t nowMs) {
        SafetyManager& g_safety = *d_.safety;
        ServoBank& g_servos = *d_.servos;
        InstrumentController& g_instrument = *d_.instrument;
        std::vector<bool>& g_stringFaulted = *d_.stringFaulted;
        Profile& g_profile = *d_.profile;

        if (estopAsserted()) return false;
        if (!ProfileValidator::isActivatable(g_profile)) return false;
        if (g_servos.directAttachFault() || g_servos.pcaAttachFault()) return false;
        g_safety.reset();
        g_safety.clearFaults();
        // A reset may be requested WHILE a note sounds ("Arm for testing"): arm()
        // parks every servo physically, so the logical state must be dropped with
        // it or the instrument/scheduler would keep a Sustaining note and a stale
        // commandId over a mechanically-reset instrument (audit 3). Same order as
        // a profile activation: logical panic first, then park.
        g_instrument.panic();
        d_.scheduler->reset();
        for (size_t i = 0; i < g_stringFaulted.size(); ++i) {
            if (g_stringFaulted[i]) {
                g_stringFaulted[i] = false;
                g_instrument.recoverString(i);
            }
        }
        return arm(nowMs);
    }

    // Immediate hard stop (E-stop / panic / major fault): cut PCA/OE and direct PWM at
    // once with no mechanical wait, cancel all commands, lock the state. Verbatim from
    // the old hardStopAll() (the test-note + pending-swap cleanup is the injected
    // hardStopCleanup callback, which main.cpp owns).
    void hardStop() {
        d_.instrument->panic();
        d_.servos->hardStop();
        d_.actuators->reset();
        d_.scheduler->reset();  // clear every string's FSM + pressed-finger state
        d_.hardStopCleanup();   // clear scheduled test-note Offs + drop a pending profile swap
        *d_.phase = AppPhase::Boot;
    }

    void panic() {
        hardStop();
        if (d_.safety->state() != SafetyState::EmergencyStop)
            d_.safety->panic("web/CC panic", millis());
    }

    void emergencyStop() {
        hardStop();
        d_.safety->emergencyStop(millis());
    }

    // Central runtime string-fault path (servo write error, PCA loss on one board…).
    // Also the fault callback PlaybackScheduler uses. Verbatim from faultRuntimeAxis().
    void faultAxis(size_t i, const char* reason, uint32_t nowMs) {
        InstrumentController& g_instrument = *d_.instrument;
        PlaybackScheduler& g_scheduler = *d_.scheduler;
        std::vector<bool>& g_stringFaulted = *d_.stringFaulted;
        SafetyManager& g_safety = *d_.safety;

        if (i >= g_instrument.stringCount()) return;
        g_instrument.faultString(i);
        // Physically release anything this string had engaged and reset its FSM.
        g_scheduler.abortString(i);
        if (i < g_stringFaulted.size()) g_stringFaulted[i] = true;
        g_safety.recordFault("string", std::string(reason) + " on string " + std::to_string(i),
                             nowMs);
        int working = d_.rebuildCaps();
        d_.notifyCaps();
        if (working <= 0) {
            hardStop();
            g_safety.panic("no operational strings remain", nowMs);
        }
    }

private:
    Deps d_;
};

}  // namespace gmb
