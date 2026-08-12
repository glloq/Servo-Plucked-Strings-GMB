// Per-string mechanical playback scheduler (audit P2.17).
//
// This is the non-blocking FSM that used to live in main.cpp::tickString(). Moving it
// into its own component shrinks main.cpp toward `app.begin()/app.tick()` and gives
// the mechanical sequencing a clear home. The FSM logic is UNCHANGED — the methods
// alias their injected collaborators to the historical `g_*` names at the top so the
// body is byte-identical to the previous tickString(); only the wiring moved.
//
//   PlaybackScheduler owns the per-string FSM state (StringSched + the currently
//   pressed finger per string). Its collaborators (InstrumentController, ServoBank,
//   ActuatorManager, the active Profile) are injected once via begin(); a fault
//   callback lets it fault an axis through the app's central fault path without the
//   scheduler needing to know about capabilities / panic escalation.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "../../core/configuration/PluckPlan.h"
#include "../../core/configuration/Profile.h"
#include "../../core/instrument/ActuatorManager.h"
#include "../../core/instrument/ActuatorResult.h"
#include "../../core/instrument/InstrumentController.h"
#include "ServoBank.h"

namespace gmb {

// Per-string non-blocking playback scheduler state (moved verbatim from main.cpp).
struct StringSched {
    enum Phase { Idle, WaitStopped, ReleasingFinger, PressingFinger, Settling, Ready,
                 StrumLiftDown, StrumLiftHold }
        phase = Idle;
    uint32_t phaseStartMs = 0;
    uint32_t commandId = 0;
    int fingerIndex = -1;        // target fret's finger servo (-1 = open / none)
    uint16_t releaseWaitMs = 0;  // time to wait for the previous finger to lift
    uint32_t dampUntilMs = 0;    // don't press until the damper has acted (replace)
    int liftIndex = -1;          // engaged strum-lift servo during a stroke
    int strikeIndex = -1;        // striker to fire once the lift has lowered
    int muteIndex = -1;          // plectrum/lift held against the string to damp (Note Off)
    uint32_t executeAtMs = 0;    // earliest time the note may sound (fixed delay)
    uint32_t readyAtMs = 0;      // when the string became Ready (anchors fretToPluckMs)
    bool executeAnchored = false;
    bool fingerPressStarted = false;  // press begun (after a governor permit)
    bool fingerSweep = false;         // direct A<->B sweep on one geared servo (no neutral)
    uint16_t fingerMoveMs = 0;        // time budget for the current finger move (press/sweep)
    uint32_t liftStartMs = 0;
    bool liftStarted = false;
};

class PlaybackScheduler {
public:
    // fault(i, reason, nowMs): route a runtime axis fault through the app's central
    // path (which itself calls abortString() back on this scheduler).
    using FaultFn = std::function<void(size_t, const char*, uint32_t)>;

    void begin(InstrumentController* instrument, ServoBank* servos,
               ActuatorManager* actuators, const Profile* profile, FaultFn fault) {
        instrument_ = instrument;
        servos_ = servos;
        actuators_ = actuators;
        profile_ = profile;
        fault_ = std::move(fault);
    }

    // (Re)size the per-string state on a profile (re)load.
    void configure(size_t stringCount) {
        sched_.assign(stringCount, StringSched{});
        currentFinger_.assign(stringCount, -1);
    }

    // Full reset of the FSM + pressed-finger state (panic / controlled park / swap).
    void reset() {
        for (auto& s : sched_) s = StringSched{};
        for (auto& f : currentFinger_) f = -1;
    }

    // Clear only the pressed-finger record for every string (arming).
    void clearCurrentFingers() {
        for (auto& f : currentFinger_) f = -1;
    }

    // Abort one string on a fault: lift its finger, drop any engaged lift, reset it.
    void abortString(size_t i) {
        ServoBank& g_servos = *servos_;
        releaseCurrentFinger(i);
        if (i < sched_.size()) {
            if (sched_[i].liftIndex >= 0) g_servos.release(sched_[i].liftIndex);
            sched_[i] = StringSched{};
        }
    }

    // Advance one string's mechanical sequence by one tick.
    void tick(size_t i, uint32_t nowMs) { tickString(i, nowMs); }

private:
    // Lift the finger currently pressed on a string (if any). Returns its travel time
    // so the caller can wait for it to physically lift before pressing the next one.
    uint16_t releaseCurrentFinger(size_t i) {
        ServoBank& g_servos = *servos_;
        std::vector<int>& g_currentFinger = currentFinger_;
        if (i >= g_currentFinger.size()) return 0;
        int fi = g_currentFinger[i];
        if (fi < 0) return 0;
        g_servos.release(fi);
        g_currentFinger[i] = -1;
        return g_servos.travelMs(fi);
    }

    // The per-string striker: the plectrum ('pluck') if present, otherwise the
    // per-string strum servo ('strum').
    int perStringStrikeIndex(size_t i) {
        ServoBank& g_servos = *servos_;
        int p = g_servos.pluckIndex(static_cast<int>(i));
        return p >= 0 ? p : g_servos.strumIndex(static_cast<int>(i));
    }

    // P1.4: a scheduler-issued actuator command that did not reach the hardware faults
    // the string, carrying the ActuatorResult reason into the fault log / web status.
    // Returns true when the command succeeded (caller proceeds), false when it faulted.
    bool actOk(ActuatorResult r, size_t i, const char* what, uint32_t nowMs) {
        if (ok(r)) return true;
        fault_(i, (std::string(what) + " [" + actuatorResultName(r) + "]").c_str(), nowMs);
        return false;
    }

    // Drive one string's mechanical sequence toward a plucked note. Body is byte-for-
    // byte the historical tickString(); the aliases below map the injected
    // collaborators + owned state to the original global names.
    void tickString(size_t i, uint32_t nowMs) {
        ServoBank& g_servos = *servos_;
        InstrumentController& g_instrument = *instrument_;
        ActuatorManager& g_actuators = *actuators_;
        const Profile& g_profile = *profile_;
        std::vector<StringSched>& g_sched = sched_;
        std::vector<int>& g_currentFinger = currentFinger_;

        StringController& sc = g_instrument.string(i);
        const StringTarget& tgt = g_instrument.target(i);
        StringSched& sch = g_sched[i];

        if (!tgt.active) {
            if (sch.phase == StringSched::Idle) return;
            if (sch.phase != StringSched::WaitStopped) {
                // Note released / cancelled: lift the finger, then damp per the global
                // mute policy resolved against what this string actually has wired — a
                // damper servo, the plectrum's own mute angle (rest against the string,
                // no dedicated damper), the strum lift, or nothing.
                sch.releaseWaitMs = releaseCurrentFinger(i);
                if (sch.liftIndex >= 0) { g_servos.release(sch.liftIndex); sch.liftIndex = -1; }
                sch.liftStarted = false;
                sch.muteIndex = -1;

                int di = g_servos.damperIndex(static_cast<int>(i));
                int pi = perStringStrikeIndex(i);
                int li = g_servos.strumLiftIndex(static_cast<int>(i));
                uint32_t muteWaitMs = 0;
                // Raise-to-play: the lift already rests ON the string, so releasing it
                // (just above) mutes — no other actuator should move, and pressing one
                // would fight it. Otherwise damp via the resolved mute source.
                if (!liftMutesAtRest(g_profile.pluck, li >= 0)) {
                    bool strikerHasMute = pi >= 0 && g_servos.muteUs(pi) != 0;
                    MuteSource action =
                        resolvePluckMute(g_profile.pluck, di >= 0, strikerHasMute, li >= 0);
                    switch (action) {
                        case MuteSource::Damper:
                            if (di >= 0) {
                                // Register the damper strike with the manager (P1.6): a
                                // chord Note-Off releases many dampers at once, so it is
                                // real in-rush — deadline (never throttled) but counted.
                                g_actuators.requestMove(MoveClass::Deadline, nowMs, g_servos.board(di));
                                g_servos.strike(di); muteWaitMs = g_servos.travelMs(di);
                            }
                            break;
                        case MuteSource::Plectrum:
                            // Bring the plectrum to rest against the string to damp it,
                            // then release it to rest once the mute hold has elapsed.
                            if (pi >= 0 && ok(g_servos.mute(pi))) {
                                sch.muteIndex = pi;
                                muteWaitMs = g_profile.pluck.muteHoldMs;
                            }
                            break;
                        case MuteSource::Lift:
                            if (li >= 0 && ok(g_servos.press(li))) {
                                sch.muteIndex = li;
                                muteWaitMs = g_profile.pluck.muteHoldMs;
                            }
                            break;
                        default:  // None: let the string ring / decay naturally.
                            break;
                    }
                    // A lift that doubles as an étouffoir (lower-to-play): lean it on the
                    // string at Note Off even when the primary mute came from elsewhere
                    // (unless something is already held, so only one is left to release).
                    if (g_profile.pluck.liftMuteOnNoteOff && sch.muteIndex < 0 &&
                        action != MuteSource::Lift && li >= 0 && ok(g_servos.press(li))) {
                        sch.muteIndex = li;
                        if (g_profile.pluck.muteHoldMs > muteWaitMs) muteWaitMs = g_profile.pluck.muteHoldMs;
                    }
                }
                if (muteWaitMs > sch.releaseWaitMs) sch.releaseWaitMs = muteWaitMs;
                sch.phase = StringSched::WaitStopped;
                sch.phaseStartMs = nowMs;
            }
            // Declare idle once the finger has lifted and any held mute has released.
            if (nowMs - sch.phaseStartMs >= sch.releaseWaitMs) {
                if (sch.muteIndex >= 0) { g_servos.release(sch.muteIndex); sch.muteIndex = -1; }
                sc.dampingDone();
                sch.phase = StringSched::Idle;
                sch.commandId = 0;
            }
            return;
        }

        if (sch.commandId != tgt.commandId) {
            // New note replacing a previous one on this string: damp the still-ringing
            // string and wait for the damper before pressing the new fret.
            sch.dampUntilMs = nowMs;
            if (sch.phase != StringSched::Idle && sch.phase != StringSched::WaitStopped) {
                int di = g_servos.damperIndex(static_cast<int>(i));
                if (di >= 0) {
                    g_actuators.requestMove(MoveClass::Deadline, nowMs, g_servos.board(di));  // P1.6
                    g_servos.strike(di);
                    sch.dampUntilMs = nowMs + g_servos.travelMs(di) + g_servos.settleMs(di);
                }
            }
            if (sch.liftIndex >= 0) { g_servos.release(sch.liftIndex); sch.liftIndex = -1; }
            // Drop any Note-Off mute still held from the previous note (plectrum against
            // the string, or a lift leaning on it) before starting the new one.
            if (sch.muteIndex >= 0) { g_servos.release(sch.muteIndex); sch.muteIndex = -1; }
            sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
            sch.executeAnchored = sc.willArmOnSettle();
            sch.fingerPressStarted = false;
            sch.liftStarted = false;
            sch.strikeIndex = -1;
            sch.commandId = tgt.commandId;
            // Direct sweep: when the target fret is driven by the SAME servo already
            // pressed — a geared finger's other side, or a re-fret of the same fret —
            // keep it engaged and sweep straight to the new side instead of lifting
            // through neutral (no spurious release, the finger stays powered). Otherwise
            // lift the current finger and wait for it to travel up before pressing the
            // new fret (never two fingers driving at once on a string).
            int prevFinger = i < g_currentFinger.size() ? g_currentFinger[i] : -1;
            int targetFinger = g_servos.fingerIndexForFret(static_cast<int>(i), tgt.fret);
            sch.fingerSweep = (prevFinger >= 0 && targetFinger == prevFinger);
            sch.releaseWaitMs = sch.fingerSweep ? 0 : releaseCurrentFinger(i);
            sch.phase = StringSched::ReleasingFinger;
            sch.phaseStartMs = nowMs;
        }

        // A prepared (anticipated) note is "received" when its Note On triggers it.
        if (!sch.executeAnchored && sc.consumeTriggerEdge()) {
            sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
            sch.executeAnchored = true;
        }

        switch (sch.phase) {
            case StringSched::ReleasingFinger:
                // Once the previous finger has lifted and the damper has acted, select
                // the target fret's finger and advance the FSM (no carriage: instant).
                if (nowMs - sch.phaseStartMs >= sch.releaseWaitMs &&
                    static_cast<int32_t>(nowMs - sch.dampUntilMs) >= 0) {
                    sch.fingerIndex = g_servos.fingerIndexForFret(static_cast<int>(i), tgt.fret);
                    sc.motionReached();  // ReleasingFinger -> Moving -> Pressing/ReadyToPluck
                    if (sc.openString()) {
                        sch.phase = StringSched::Ready;  // open: no finger press
                        sch.readyAtMs = nowMs;
                    } else if (sch.fingerIndex < 0) {
                        // Fretted note but this fret has no finger servo (a gap / partial
                        // install). Don't hang: advance the FSM so it still plucks the
                        // open string. The validator warns about this configuration.
                        sc.fingerPressed();
                        sc.settled();
                        sch.phase = StringSched::Ready;
                        sch.readyAtMs = nowMs;
                    } else {
                        sch.phase = StringSched::PressingFinger;
                        sch.phaseStartMs = nowMs;
                        sch.fingerPressStarted = false;
                    }
                }
                break;
            case StringSched::PressingFinger:
                // Ask the governor for a start permit before driving the finger, so a
                // chord's presses are staggered and the PCA in-rush stays bounded.
                if (!sch.fingerPressStarted) {
                    // Permit gated by both the global and this finger's PCA-board cap.
                    // A finger press is a staggerable, current-hungry positioning move —
                    // gate it through the ActuatorManager (a pluck strike, being a sonic
                    // deadline, is never gated). P1.6.
                    if (!g_actuators.requestMove(MoveClass::Staggerable, nowMs,
                                                 g_servos.board(sch.fingerIndex)))
                        break;
                    // A direct sweep travels farther than a press from neutral (it crosses
                    // the whole A..B span), so budget the wait by the real pulse distance;
                    // a normal press from neutral uses the calibrated travelMs. Compute it
                    // BEFORE pressFret writes the new target (sweep time reads the current
                    // pulse).
                    sch.fingerMoveMs = sch.fingerSweep
                        ? g_servos.sweepMsToFret(sch.fingerIndex, tgt.fret)
                        : g_servos.travelMs(sch.fingerIndex);
                    // pressFret drives a geared finger toward the correct antagonistic
                    // side for tgt.fret (activeUs for side A, activeBUs for side B); for
                    // a plain single finger it is identical to press().
                    if (!actOk(g_servos.pressFret(sch.fingerIndex, tgt.fret), i,
                               "finger servo write failed", nowMs))
                        break;
                    g_currentFinger[i] = sch.fingerIndex;
                    sch.fingerPressStarted = true;
                    sch.phaseStartMs = nowMs;
                }
                if (nowMs - sch.phaseStartMs >= sch.fingerMoveMs) {
                    sc.fingerPressed();
                    sch.phase = StringSched::Settling;
                    sch.phaseStartMs = nowMs;
                }
                break;
            case StringSched::Settling: {
                // Strum lead: begin lowering the strum lift up to strumLeadMs before the
                // string is Ready (overlaps the lift travel with the finger settle).
                if (!sch.liftStarted && sc.willArmOnSettle() && g_profile.midi.strumLeadMs > 0) {
                    int pi = perStringStrikeIndex(i);
                    int li = pi >= 0 ? g_servos.strumLiftIndex(static_cast<int>(i)) : -1;
                    uint32_t settle = g_servos.settleMs(sch.fingerIndex);
                    if (li >= 0 &&
                        (nowMs - sch.phaseStartMs) + g_profile.midi.strumLeadMs >= settle) {
                        if (!actOk(g_servos.press(li), i, "strum lift servo write failed", nowMs))
                            break;
                        sch.liftIndex = li;
                        sch.strikeIndex = pi;
                        sch.liftStartMs = nowMs;
                        sch.liftStarted = true;
                    }
                }
                uint16_t settle = sch.fingerIndex >= 0 ? g_servos.settleMs(sch.fingerIndex) : 0;
                if (nowMs - sch.phaseStartMs >= settle) {
                    sc.settled();
                    sch.phase = StringSched::Ready;
                    sch.readyAtMs = nowMs;  // anchors the fret->pluck delay
                }
                break;
            }
            case StringSched::Ready: {
                if (!sch.executeAnchored && sc.pluckArmed()) {
                    sch.executeAtMs = nowMs + g_profile.midi.noteExecutionDelayMs;
                    sch.executeAnchored = true;
                }
                if (!sc.pluckArmed()) break;
                // The strike waits for BOTH the fixed Note-On latency (executeAtMs) and
                // the fret->pluck settle measured from when the string became Ready, so a
                // freshly fretted string is given time to stabilise before it is plucked
                // ("delay between fret action and plucking").
                uint32_t strikeAtMs = sch.executeAtMs;
                if (g_profile.pluck.fretToPluckMs != 0) {
                    uint32_t floorMs = sch.readyAtMs + g_profile.pluck.fretToPluckMs;
                    if (static_cast<int32_t>(floorMs - strikeAtMs) > 0) strikeAtMs = floorMs;
                }
                int pi = perStringStrikeIndex(i);
                // Pre-lower the strum lift DURING the wait so the strike lands AT
                // strikeAtMs even with a lift — the plectrum is in place at the frappe.
                if (pi >= 0 && !sch.liftStarted) {
                    int li = g_servos.strumLiftIndex(static_cast<int>(i));
                    if (li >= 0) {
                        uint32_t liftMs = g_servos.travelMs(li) + g_servos.engageDelayMs(li);
                        if (static_cast<int32_t>(nowMs - strikeAtMs) +
                                static_cast<int32_t>(liftMs) >= 0) {
                            if (!actOk(g_servos.press(li), i, "strum lift servo write failed", nowMs))
                                break;
                            sch.liftIndex = li;
                            sch.strikeIndex = pi;
                            sch.liftStartMs = nowMs;
                            sch.liftStarted = true;
                        }
                    }
                }
                if (static_cast<int32_t>(nowMs - strikeAtMs) < 0) break;
                if (!sc.executePluck(tgt.commandId)) break;
                if (pi >= 0) {
                    int li = sch.liftStarted ? sch.liftIndex
                                             : g_servos.strumLiftIndex(static_cast<int>(i));
                    if (li >= 0) {
                        if (!sch.liftStarted) {
                            if (!actOk(g_servos.press(li), i, "strum lift servo write failed", nowMs))
                                break;
                            sch.liftIndex = li;
                            sch.strikeIndex = pi;
                            sch.liftStartMs = nowMs;
                            sch.liftStarted = true;
                        }
                        sch.phase = StringSched::StrumLiftDown;
                        break;
                    }
                    // The actual pluck: register it as a deadline move (P1.6 — the sonic
                    // beat, never throttled but counted), then fault the string if the
                    // strike did not reach the hardware (P1.4). The switch breaks straight
                    // after, so the faulted scheduler reset stands.
                    g_actuators.requestMove(MoveClass::Deadline, nowMs, g_servos.board(pi));
                    actOk(g_servos.strike(pi, tgt.intensity), i, "pluck servo write failed", nowMs);
                }
                break;
            }
            case StringSched::StrumLiftDown:
                if (static_cast<int32_t>(nowMs - (sch.liftStartMs +
                        g_servos.travelMs(sch.liftIndex) +
                        g_servos.engageDelayMs(sch.liftIndex))) >= 0) {
                    g_actuators.requestMove(MoveClass::Deadline, nowMs,
                                            g_servos.board(sch.strikeIndex));  // P1.6
                    if (!actOk(g_servos.strike(sch.strikeIndex, tgt.intensity), i,
                               "pluck servo write failed", nowMs))
                        break;  // faulted: do not advance the (now reset) scheduler
                    sch.phase = StringSched::StrumLiftHold;
                    sch.phaseStartMs = nowMs;
                }
                break;
            case StringSched::StrumLiftHold:
                if (nowMs - sch.phaseStartMs >= g_servos.travelMs(sch.strikeIndex)) {
                    if (g_profile.pluck.liftEngage == LiftEngage::RaiseToPlay) {
                        // Raise-to-play: KEEP the plectrum lifted (string free to ring)
                        // for the whole note; it falls back onto the string — muting —
                        // only when the lift returns to rest at Note Off.
                        sch.strikeIndex = -1;
                    } else {
                        // Lower-to-play: retract the lift now so the plectrum clears the
                        // ringing string.
                        g_servos.release(sch.liftIndex);
                        sch.liftIndex = -1;
                        sch.strikeIndex = -1;
                    }
                    sch.phase = StringSched::Ready;
                }
                break;
            case StringSched::WaitStopped:
            case StringSched::Idle:
                break;
        }
    }

    InstrumentController* instrument_ = nullptr;
    ServoBank* servos_ = nullptr;
    ActuatorManager* actuators_ = nullptr;
    const Profile* profile_ = nullptr;
    FaultFn fault_;
    std::vector<StringSched> sched_;
    std::vector<int> currentFinger_;
};

}  // namespace gmb
