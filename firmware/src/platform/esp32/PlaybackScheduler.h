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
    int pendingDamper = -1;      // Note-Off damper awaiting a governor permit (P1.6), or -1
    int pendingFingerRelease = -1;  // finger lift awaiting a governor permit, or -1
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
        pendingExecuteAt_.assign(stringCount, 0);
    }

    // Full reset of the FSM + pressed-finger state (panic / controlled park / swap).
    void reset() {
        for (auto& s : sched_) s = StringSched{};
        for (auto& f : currentFinger_) f = -1;
        for (auto& t : pendingExecuteAt_) t = 0;
    }

    // Chord synchronisation (audit): call ONCE per loop pass, BEFORE the per-string
    // tick()s. A chord flushed by the InstrumentController lands as several fresh
    // targets in the same pass — and a chord of CC-PREPARED notes lands as several
    // trigger edges (same commandId, so a fresh-command test alone would miss them,
    // audit follow-up). When two or more arrive together, give them a COMMON strike
    // deadline that covers the SLOWEST member's estimated mechanical preparation
    // (damper wait + finger release/press travel + settle + the global fret->pluck
    // delay — or the REMAINING preparation of an already-moving prepared string),
    // the governor's stagger of the chord's finger releases/presses and lift
    // engages, and the fixed noteExecutionDelayMs floor. Each string still waits
    // for its own REAL mechanics via the Ready-phase max(), so an under-estimate
    // degrades gracefully; the shared deadline is what makes the chord's strings
    // strike together instead of each as soon as it is ready.
    // A single member keeps the plain fixed-delay anchor (no estimated padding).
    void prepareTick(uint32_t nowMs) {
        if (!instrument_ || !profile_) return;
        const Profile& p = *profile_;
        const ServoBank& b = *servos_;
        struct Member { size_t i; uint32_t byDelay; uint32_t prepMs; uint32_t liftMs; };
        std::vector<Member> members;
        // Board bucket of every governed (staggerable) start this batch will issue:
        // finger releases, finger presses and lift engages — for a prepared note,
        // only the moves its FSM has NOT yet performed. 0xFF = direct GPIO (counts
        // toward the global cap only).
        std::vector<uint8_t> startBoards;
        auto addStart = [&](int servoIndex) {
            if (servoIndex >= 0) startBoards.push_back(b.board(servoIndex));
        };
        for (size_t i = 0; i < sched_.size(); ++i) {
            const StringTarget& tgt = instrument_->target(i);
            bool freshCmd = tgt.active && sched_[i].commandId != tgt.commandId;
            bool triggered =
                tgt.active && !freshCmd && instrument_->string(i).hasTriggerEdge();
            if (!freshCmd && !triggered) {
                if (i < pendingExecuteAt_.size()) pendingExecuteAt_[i] = 0;
                continue;
            }
            Member m;
            m.i = i;
            int nxt = b.fingerIndexForFret(static_cast<int>(i), tgt.fret);
            if (freshCmd) {
                // Anchor at the Note-On reception (minus the chord-buffer age).
                m.byDelay = (nowMs - tgt.queuedMs) + p.midi.noteExecutionDelayMs;
                m.prepMs = estimatePrepMs(i, tgt.fret) + p.pluck.fretToPluckMs;
                int prev = i < currentFinger_.size() ? currentFinger_[i] : -1;
                if (prev < 0) prev = sched_[i].pendingFingerRelease;
                if (prev >= 0 && prev != nxt) addStart(prev);  // governed release
                if (nxt >= 0) addStart(nxt);                   // governed press
            } else {
                // A prepared note triggered NOW: its Note On is this instant, and
                // only the REMAINING part of its move still has to happen — which
                // may still include governed starts the FSM has not been granted
                // yet (a parked release, a press awaiting its permit) (audit 3).
                m.byDelay = nowMs + p.midi.noteExecutionDelayMs;
                m.prepMs = remainingPrepMs(i, tgt.fret, nowMs) + p.pluck.fretToPluckMs;
                const StringSched& sch = sched_[i];
                if (sch.pendingFingerRelease >= 0) addStart(sch.pendingFingerRelease);
                if (sch.phase == StringSched::ReleasingFinger ||
                    (sch.phase == StringSched::PressingFinger && !sch.fingerPressStarted))
                    addStart(nxt);  // press still ahead of / awaiting the governor
            }
            m.liftMs = liftPrepMs(i);
            if (m.liftMs) addStart(b.strumLiftIndex(static_cast<int>(i)));
            members.push_back(m);
        }
        if (members.empty()) return;
        // The governor staggers the batch's governed starts under TWO simultaneous
        // caps: the global window AND each PCA board's own window (audit 3 — using
        // one or the other under-/over-estimated the wait). The worst extra delay
        // before the LAST start is the max over every constraint's own queue:
        //   perConstraint = floor((starts_in_that_window - 1) / cap) x staggerMs.
        uint32_t governorBudget = 0;
        if (p.power.staggerMs != 0 && startBoards.size() > 1) {
            if (p.power.maxConcurrentMoves > 0) {
                uint32_t g = (static_cast<uint32_t>(startBoards.size() - 1) /
                              p.power.maxConcurrentMoves) * p.power.staggerMs;
                if (g > governorBudget) governorBudget = g;
            }
            if (p.power.maxConcurrentPerBoard > 0) {
                // Count the batch's starts per physical PCA board (0xFF = direct
                // GPIO: no per-board window applies).
                for (size_t a = 0; a < startBoards.size(); ++a) {
                    if (startBoards[a] == 0xFF) continue;
                    uint32_t n = 0;
                    for (uint8_t bd : startBoards)
                        if (bd == startBoards[a]) ++n;
                    if (n > 1) {
                        uint32_t g = ((n - 1) / p.power.maxConcurrentPerBoard) *
                                     p.power.staggerMs;
                        if (g > governorBudget) governorBudget = g;
                    }
                }
            }
        }
        uint32_t deadline = 0;
        bool first = true;
        for (const Member& m : members) {
            uint32_t mech = m.prepMs;
            if (m.liftMs > mech) mech = m.liftMs;  // lift lowers in parallel
            uint32_t byMech = nowMs + mech + governorBudget;
            uint32_t want = static_cast<int32_t>(byMech - m.byDelay) > 0 ? byMech : m.byDelay;
            if (first || static_cast<int32_t>(want - deadline) > 0) deadline = want;
            first = false;
        }
        for (const Member& m : members) {
            // Solo notes keep the un-padded fixed-delay anchor (handled in tick).
            pendingExecuteAt_[m.i] = members.size() >= 2 ? deadline : 0;
        }
    }

    // Clear only the pressed-finger record for every string (arming).
    void clearCurrentFingers() {
        for (auto& f : currentFinger_) f = -1;
    }

    // Abort one string on a fault: IMMEDIATE, best-effort mechanical cleanup of
    // EVERYTHING this string may hold engaged, bypassing the governor (safety never
    // waits for a start permit) and ignoring write results (an abort must not
    // recurse into the fault path). Covers the pressed finger, a finger release
    // still parked on a denied governor permit (the servo is STILL physically
    // pressed even though currentFinger_ was already cleared — audit 3 P0), an
    // engaged strum lift, and a plectrum/lift held against the string as a mute.
    void abortString(size_t i) {
        ServoBank& g_servos = *servos_;
        releaseCurrentFinger(i);
        if (i < sched_.size()) {
            StringSched& sch = sched_[i];
            if (sch.pendingFingerRelease >= 0) g_servos.release(sch.pendingFingerRelease);
            if (sch.liftIndex >= 0) g_servos.release(sch.liftIndex);
            if (sch.muteIndex >= 0) g_servos.release(sch.muteIndex);
            sched_[i] = StringSched{};
        }
    }

    // Advance one string's mechanical sequence by one tick.
    void tick(size_t i, uint32_t nowMs) { tickString(i, nowMs); }

    // Notes abandoned because a fretted target had no finger servo (the safety net
    // that used to play the WRONG open note instead — audit follow-up). Diagnostics.
    uint32_t droppedNoFingerCount() const { return droppedNoFinger_; }

private:
    // Lift the finger currently pressed on a string (if any) IMMEDIATELY, bypassing
    // the governor — the fault/abort path only (safety must never wait for a start
    // permit). Returns its travel time.
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

    // Start (or queue) the release of the pressed finger THROUGH the governor: a
    // release draws its in-rush like a press, so a chord's simultaneous Note Offs
    // must be staggered too (audit follow-up — releases used to bypass the cap).
    // `waitMs` receives the travel budget; when the permit is denied the release is
    // parked in sch.pendingFingerRelease and the retry path extends the wait when
    // it starts. Returns false when the release WRITE failed: the axis has been
    // faulted and this string's scheduler state reset — the caller must stop
    // touching it (audit 3: no mechanical command may pass unchecked).
    bool startGovernedRelease(size_t i, StringSched& sch, uint32_t nowMs,
                              uint16_t& waitMs) {
        ServoBank& g_servos = *servos_;
        ActuatorManager& g_actuators = *actuators_;
        waitMs = 0;
        if (i >= currentFinger_.size()) return true;
        int fi = currentFinger_[i];
        if (fi < 0) return true;
        currentFinger_[i] = -1;
        waitMs = g_servos.travelMs(fi);
        if (g_actuators.requestMove(MoveClass::Staggerable, nowMs, g_servos.board(fi))) {
            if (!actOk(g_servos.release(fi), i, "finger release write failed", nowMs))
                return false;
        } else {
            sch.pendingFingerRelease = fi;  // retried each tick; wait extended then
        }
        return true;
    }

    // Retry a governor-deferred finger release. Returns +1 the moment no release is
    // pending (started now or none queued), 0 while still waiting for a permit, and
    // -1 when the release write failed (axis faulted, scheduler state reset — the
    // caller must stop touching it). Extends `waitMs` so the caller never declares
    // the finger lifted before it has actually travelled.
    int serviceFingerRelease(size_t i, StringSched& sch, uint32_t nowMs,
                             uint16_t& waitMs) {
        if (sch.pendingFingerRelease < 0) return 1;
        ServoBank& g_servos = *servos_;
        ActuatorManager& g_actuators = *actuators_;
        if (!g_actuators.requestMove(MoveClass::Staggerable, nowMs,
                                     g_servos.board(sch.pendingFingerRelease)))
            return 0;
        int fi = sch.pendingFingerRelease;
        sch.pendingFingerRelease = -1;
        uint32_t doneMs = (nowMs - sch.phaseStartMs) + g_servos.travelMs(fi);
        if (doneMs > waitMs) waitMs = static_cast<uint16_t>(doneMs > 0xFFFF ? 0xFFFF : doneMs);
        if (!actOk(g_servos.release(fi), i, "finger release write failed", nowMs))
            return -1;
        return 1;
    }

    // The per-string striker: the plectrum ('pluck') if present, otherwise the
    // per-string strum servo ('strum').
    int perStringStrikeIndex(size_t i) {
        ServoBank& g_servos = *servos_;
        int p = g_servos.pluckIndex(static_cast<int>(i));
        return p >= 0 ? p : g_servos.strumIndex(static_cast<int>(i));
    }

    // Estimated mechanical preparation for string `i` to reach a Ready-to-strike
    // state on `fret`, from the CURRENT scheduler state: damper wait when replacing
    // a still-sounding note, previous-finger release travel, target-finger press (or
    // direct geared sweep) travel and settle. Powers the chord-group deadline in
    // prepareTick(); the Ready-phase max() against the real mechanics remains the
    // hard guarantee, so this only needs to be a good estimate.
    uint32_t estimatePrepMs(size_t i, int fret) const {
        const ServoBank& b = *servos_;
        const StringSched& sch = sched_[i];
        uint32_t prep = 0;
        if (sch.phase != StringSched::Idle && sch.phase != StringSched::WaitStopped) {
            int di = b.damperIndex(static_cast<int>(i));
            if (di >= 0)
                prep += static_cast<uint32_t>(b.strikeDurationMs(di)) + b.settleMs(di);
        }
        int prev = i < currentFinger_.size() ? currentFinger_[i] : -1;
        if (prev < 0) prev = sch.pendingFingerRelease;  // release queued, not yet begun
        int nxt = b.fingerIndexForFret(static_cast<int>(i), fret);
        bool sweep = prev >= 0 && nxt == prev;
        if (!sweep && prev >= 0) prep += b.travelMs(prev);  // lift the previous finger
        if (nxt >= 0) {
            prep += sweep ? b.sweepMsToFret(nxt, fret) : b.travelMs(nxt);
            prep += b.settleMs(nxt);
        }
        return prep;
    }

    // REMAINING mechanical preparation of a string already mid-flight — a
    // CC-prepared note being triggered by its Note On: what is left of the current
    // FSM phase plus the phases still ahead. Powers the chord grouping of prepared
    // notes in prepareTick() (audit follow-up).
    uint32_t remainingPrepMs(size_t i, int fret, uint32_t nowMs) const {
        const ServoBank& b = *servos_;
        const Profile& p = *profile_;
        const StringSched& sch = sched_[i];
        uint32_t elapsed = nowMs - sch.phaseStartMs;
        auto left = [&](uint32_t budget) { return budget > elapsed ? budget - elapsed : 0u; };
        int nxt = b.fingerIndexForFret(static_cast<int>(i), fret);
        uint32_t press = nxt >= 0 ? b.travelMs(nxt) : 0;
        uint32_t settle = nxt >= 0 ? b.settleMs(nxt) : 0;
        // A move still WAITING on a governor permit may sit out up to one full
        // stagger window behind starts granted before this batch (audit 3).
        bool governorOn = p.power.staggerMs != 0 &&
                          (p.power.maxConcurrentMoves > 0 ||
                           p.power.maxConcurrentPerBoard > 0);
        uint32_t permitWait = governorOn ? p.power.staggerMs : 0;
        switch (sch.phase) {
            case StringSched::ReleasingFinger:
                // A release still parked on a denied governor permit has performed
                // NONE of its motion yet, whatever the elapsed time says (audit 3).
                if (sch.pendingFingerRelease >= 0)
                    return permitWait +
                           static_cast<uint32_t>(b.travelMs(sch.pendingFingerRelease)) +
                           press + settle;
                return left(sch.releaseWaitMs) + press + settle;
            case StringSched::PressingFinger:
                if (!sch.fingerPressStarted)
                    return permitWait + press + settle;  // press awaiting its permit
                return left(sch.fingerMoveMs) + settle;
            case StringSched::Settling:
                return left(sch.fingerIndex >= 0 ? b.settleMs(sch.fingerIndex) : 0);
            default:
                return 0;  // Ready (or beyond): mechanically in place
        }
    }

    // Time a string's strum lift needs to be engaged before its strike (0 when the
    // string has no striker+lift pair). Runs in parallel with the finger work.
    uint32_t liftPrepMs(size_t i) const {
        const ServoBank& b = *servos_;
        int pi = b.pluckIndex(static_cast<int>(i));
        if (pi < 0) pi = b.strumIndex(static_cast<int>(i));
        if (pi < 0) return 0;
        int li = b.strumLiftIndex(static_cast<int>(i));
        if (li < 0) return 0;
        return static_cast<uint32_t>(b.travelMs(li)) + b.engageDelayMs(li);
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
                // Note released / cancelled: lift the finger (governed — a chord's
                // simultaneous Note Offs release many fingers at once), then damp per
                // the global mute policy resolved against what this string actually
                // has wired — a damper servo, the plectrum's own mute angle (rest
                // against the string, no dedicated damper), the strum lift, or nothing.
                if (!startGovernedRelease(i, sch, nowMs, sch.releaseWaitMs)) return;
                if (sch.liftIndex >= 0) {
                    int li = sch.liftIndex;
                    sch.liftIndex = -1;
                    if (!actOk(g_servos.release(li), i, "strum lift release write failed",
                               nowMs))
                        return;
                }
                sch.liftStarted = false;
                sch.muteIndex = -1;

                int di = g_servos.damperIndex(static_cast<int>(i));
                int pi = perStringStrikeIndex(i);
                int li = g_servos.strumLiftIndex(static_cast<int>(i));
                uint32_t muteWaitMs = 0;
                // Raise-to-play: the lift already rests ON the string, so releasing it
                // (just above) mutes — no other actuator should move, and pressing one
                // would fight it. The fall back onto the string still takes the lift's
                // real travel: wait for it before declaring the string damped (audit:
                // the mute must never be reported done before the actuator arrived).
                if (liftMutesAtRest(g_profile.pluck, li >= 0)) {
                    muteWaitMs = g_servos.travelMs(li);
                } else {
                    bool strikerHasMute = pi >= 0 && g_servos.muteUs(pi) != 0;
                    MuteSource action =
                        resolvePluckMute(g_profile.pluck, di >= 0, strikerHasMute, li >= 0);
                    switch (action) {
                        case MuteSource::Damper:
                            if (di >= 0) {
                                // Throttle the damper strike through the governor (P1.6):
                                // a chord Note-Off releases many dampers at once (real
                                // in-rush). Defer it to the pending-damper retry below so
                                // the governor can stagger the burst; reserve its strike
                                // engagement in the wait budget now. A mute delayed a few
                                // ms only lets the string ring a hair longer — no missed
                                // beat.
                                sch.pendingDamper = di;
                                muteWaitMs = g_servos.strikeDurationMs(di);
                            }
                            break;
                        case MuteSource::Plectrum:
                            // Bring the plectrum to rest against the string to damp it,
                            // then release it once it has PHYSICALLY reached the string
                            // (travelMs) and held for muteHoldMs. Without the travel
                            // term the hold used to elapse mid-flight and the plectrum
                            // was recalled before it ever touched the string (audit).
                            if (pi >= 0 && ok(g_servos.mute(pi))) {
                                sch.muteIndex = pi;
                                muteWaitMs = static_cast<uint32_t>(g_servos.travelMs(pi)) +
                                             g_profile.pluck.muteHoldMs;
                            }
                            break;
                        case MuteSource::Lift:
                            if (li >= 0 && ok(g_servos.press(li))) {
                                sch.muteIndex = li;
                                muteWaitMs = static_cast<uint32_t>(g_servos.travelMs(li)) +
                                             g_profile.pluck.muteHoldMs;
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
                        uint32_t w = static_cast<uint32_t>(g_servos.travelMs(li)) +
                                     g_profile.pluck.muteHoldMs;
                        if (w > muteWaitMs) muteWaitMs = w;
                    }
                }
                if (muteWaitMs > sch.releaseWaitMs) sch.releaseWaitMs = muteWaitMs;
                sch.phase = StringSched::WaitStopped;
                sch.phaseStartMs = nowMs;
            }
            // A deferred Note-Off damper: retry its start each tick until the governor
            // permits it (P1.6). When it fires late, extend the wait so the string is
            // not declared idle before the damper has physically travelled.
            if (sch.pendingDamper >= 0 &&
                g_actuators.requestMove(MoveClass::Staggerable, nowMs,
                                        g_servos.board(sch.pendingDamper))) {
                int di = sch.pendingDamper;
                sch.pendingDamper = -1;
                uint32_t doneMs = (nowMs - sch.phaseStartMs) +
                                  g_servos.strikeDurationMs(di);
                if (doneMs > sch.releaseWaitMs)
                    sch.releaseWaitMs = static_cast<uint16_t>(doneMs > 0xFFFF ? 0xFFFF : doneMs);
                if (!actOk(g_servos.strike(di), i, "damper servo write failed", nowMs))
                    return;
            }
            // A governor-deferred finger release: keep retrying until it starts, and
            // stretch the wait so the string is not declared idle before the finger
            // has physically lifted.
            if (serviceFingerRelease(i, sch, nowMs, sch.releaseWaitMs) < 0) return;
            // Declare idle once the finger has lifted, any held mute has released, AND
            // no damper or finger release is still waiting for its permit.
            if (sch.pendingDamper < 0 && sch.pendingFingerRelease < 0 &&
                nowMs - sch.phaseStartMs >= sch.releaseWaitMs) {
                if (sch.muteIndex >= 0) {
                    int mi = sch.muteIndex;
                    sch.muteIndex = -1;
                    if (!actOk(g_servos.release(mi), i, "mute release write failed", nowMs))
                        return;
                }
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
                    sch.dampUntilMs = nowMs + g_servos.strikeDurationMs(di) +
                                      g_servos.settleMs(di);
                    if (!actOk(g_servos.strike(di), i, "damper servo write failed", nowMs))
                        return;
                }
            }
            if (sch.liftIndex >= 0) {
                int li = sch.liftIndex;
                sch.liftIndex = -1;
                if (!actOk(g_servos.release(li), i, "strum lift release write failed", nowMs))
                    return;
            }
            // Drop any Note-Off mute still held from the previous note (plectrum against
            // the string, or a lift leaning on it) before starting the new one.
            if (sch.muteIndex >= 0) {
                int mi = sch.muteIndex;
                sch.muteIndex = -1;
                if (!actOk(g_servos.release(mi), i, "mute release write failed", nowMs))
                    return;
            }
            sch.pendingDamper = -1;  // a new note supersedes an interrupted Note-Off damper
            // Fixed-latency anchor: measured from the Note On's RECEPTION (nowMs minus
            // the time the note sat in the chord-grouping buffer), so chordWindowMs no
            // longer silently adds to the configured latency. When prepareTick() has
            // computed a common chord deadline for this tick's batch, use it — that is
            // what makes a chord's strings actually land together (audit).
            {
                uint32_t anchorMs = nowMs - tgt.queuedMs;
                uint32_t at = anchorMs + g_profile.midi.noteExecutionDelayMs;
                if (i < pendingExecuteAt_.size() && pendingExecuteAt_[i] != 0) {
                    at = pendingExecuteAt_[i];
                    pendingExecuteAt_[i] = 0;
                }
                sch.executeAtMs = at;
            }
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
            sch.releaseWaitMs = 0;
            if (!sch.fingerSweep &&
                !startGovernedRelease(i, sch, nowMs, sch.releaseWaitMs))
                return;  // release write failed: axis faulted, state reset
            // A release still pending from the PREVIOUS note (its permit never came)
            // carries over: the ReleasingFinger phase below keeps retrying it and
            // will not press the new finger before the old one has lifted.
            if (sch.pendingFingerRelease >= 0 &&
                g_servos.travelMs(sch.pendingFingerRelease) > sch.releaseWaitMs)
                sch.releaseWaitMs = g_servos.travelMs(sch.pendingFingerRelease);
            sch.phase = StringSched::ReleasingFinger;
            sch.phaseStartMs = nowMs;
        }

        // A prepared (anticipated) note is "received" when its Note On triggers it.
        // When prepareTick() grouped this trigger with others into a common chord
        // deadline, use it — a chord of prepared notes must land together too.
        if (!sch.executeAnchored && sc.consumeTriggerEdge()) {
            uint32_t at = nowMs + g_profile.midi.noteExecutionDelayMs;
            if (i < pendingExecuteAt_.size() && pendingExecuteAt_[i] != 0) {
                at = pendingExecuteAt_[i];
                pendingExecuteAt_[i] = 0;
            }
            sch.executeAtMs = at;
            sch.executeAnchored = true;
        }

        switch (sch.phase) {
            case StringSched::ReleasingFinger:
                // A previous finger still waiting for its release permit: retry it and
                // hold this phase — never two fingers driving at once on a string.
                if (serviceFingerRelease(i, sch, nowMs, sch.releaseWaitMs) <= 0) break;
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
                        // Fretted note but this fret has no finger servo — a config
                        // gap / race the allocator and selector normally prevent.
                        // ABANDON the note instead of sounding the wrong (open)
                        // pitch, and count it for diagnostics (audit follow-up: a
                        // safety net must fail silent, not play a wrong note).
                        ++droppedNoFinger_;
                        g_instrument.cancelNote(static_cast<int>(i));
                        sch.phase = StringSched::Idle;
                        sch.commandId = 0;
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
                    // An anticipated lift engage is a positioning move with slack:
                    // gate it through the governor so a chord's lifts stagger like its
                    // finger presses (audit: lifts bypassed the current limiter). A
                    // denied permit just retries next tick.
                    if (li >= 0 &&
                        (nowMs - sch.phaseStartMs) + g_profile.midi.strumLeadMs >= settle &&
                        g_actuators.requestMove(MoveClass::Staggerable, nowMs,
                                                g_servos.board(li))) {
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
                        // Pre-lowering has slack (we only need the lift down by
                        // strikeAtMs): a governed, staggerable move like the finger
                        // presses (audit). A denied permit retries next tick; the
                        // last-moment engage below stays a deadline move. The window
                        // opens (stagger x strings) EARLY so the governor can spread
                        // a chord's lifts and still have every one down on the beat.
                        uint32_t lead = liftMs +
                            static_cast<uint32_t>(g_profile.power.staggerMs) *
                                static_cast<uint32_t>(g_sched.size());
                        if (static_cast<int32_t>(nowMs - strikeAtMs) +
                                static_cast<int32_t>(lead) >= 0 &&
                            g_actuators.requestMove(MoveClass::Staggerable, nowMs,
                                                    g_servos.board(li))) {
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
                            // The strike moment is here and the lift is still up: it
                            // must engage NOW or the beat is lost — register it as a
                            // deadline move (counted for the in-rush picture, never
                            // throttled), like the strike it enables (P1.6/audit).
                            g_actuators.requestMove(MoveClass::Deadline, nowMs,
                                                    g_servos.board(li));
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
                // Wait for the REAL stroke engagement (strokeMs when calibrated, else
                // travelMs) — the same clock ServoBank::update() runs on — so the lift
                // can never retract the plectrum while the stroke is still engaged.
                if (nowMs - sch.phaseStartMs >= g_servos.strikeDurationMs(sch.strikeIndex)) {
                    if (g_profile.pluck.liftEngage == LiftEngage::RaiseToPlay) {
                        // Raise-to-play: KEEP the plectrum lifted (string free to ring)
                        // for the whole note; it falls back onto the string — muting —
                        // only when the lift returns to rest at Note Off.
                        sch.strikeIndex = -1;
                    } else {
                        // Lower-to-play: retract the lift now so the plectrum clears the
                        // ringing string.
                        int li = sch.liftIndex;
                        sch.liftIndex = -1;
                        sch.strikeIndex = -1;
                        if (!actOk(g_servos.release(li), i,
                                   "strum lift release write failed", nowMs))
                            break;  // faulted: the scheduler state was reset
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
    // Per-string common chord deadline computed by prepareTick() for targets that
    // arrived together in this pass; 0 = none (solo note / already consumed).
    std::vector<uint32_t> pendingExecuteAt_;
    uint32_t droppedNoFinger_ = 0;  // fretted notes abandoned for lack of a finger servo
};

}  // namespace gmb
