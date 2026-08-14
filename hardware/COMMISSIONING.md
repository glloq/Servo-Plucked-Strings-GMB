# Commissioning — electrical acceptance procedure

Staged power-up of a freshly wired (or re-wired) machine. Each stage has a
**gate**: do not pass it until every check holds. Instruments: a multimeter;
a current clamp or bench PSU with current readout is strongly recommended, a
scope useful at stage 6. Circuit references:
[`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md) and
[`schematics/`](schematics/README.md).

> 💻 The web interface mirrors this procedure as a live checklist (*Wiring &
> GPIO → Commissioning*), with per-instrument progress kept in the browser.
> This document stays the reference — it carries the measurements to record.

## Stage 0 — visual & mechanical (all supplies OFF)

- [ ] Every servo lead, power branch and the I²C harness routed and strain-relieved;
      lockable connectors latched.
- [ ] PCA9685 **A0–A2 jumpers** match the wiring sheet (bus + address per board).
- [ ] Branch fuses F1…Fn installed and rated per the sheet; F0 in place.
- [ ] E-stop button mounted, reachable, and **latched released**.
- [ ] No string under tension yet.

## Stage 1 — continuity & shorts (all supplies OFF)

- [ ] Continuity: every GND (ESP32, PCA boards, PSU, distribution block) is one net.
- [ ] **No** continuity between `+V_SERVO` and GND, `3V3` and GND, `+V_SERVO` and `3V3`.
- [ ] E-stop chain: NC #1 / NC #2 (/ NC #3) all **closed** with the button
      released, all **open** with it pressed.
- [ ] `/OE` bus: continuity from the pull-up node to every board's `/OE` pin;
      pull-up to 3.3 V present (measure ≈ R_pu to the 3V3 net, supplies off).

## Stage 2 — logic only (USB in, servo PSU OFF)

- [ ] ESP32-S3 boots, web UI reachable; load or build the profile.
- [ ] *Wiring & GPIO* validation: **no errors** (SDA/SCL per used bus, `/OE`,
      ESTOP if installed, no GPIO conflicts).
- [ ] With the profile loaded but **not armed**: `/OE` bus measures **HIGH**
      (≈3.3 V) — outputs disabled.
- [ ] Press the E-stop: the UI shows `EmergencyStop` (ESTOP input works);
      release + `Reset` clears it. With **NC** wiring, unplug the chain
      connector instead: same result (fail-safe check).
- [ ] I²C scan (arming attempt is enough): every configured board answers at
      its (bus, address); a missing board is reported by identity.

## Stage 3 — servo rail, outputs disabled (servo PSU ON, do not arm)

- [ ] Rail voltage at the distribution block and at **each branch** within spec
      (5–6 V, correct polarity).
- [ ] `/OE` still HIGH; **no servo twitches** at power-on.
- [ ] Idle current plausible (essentially the boards' quiescent draw).
- [ ] Press the E-stop: **K1 drops the rail** — 0 V at every branch. Release,
      re-close.

## Stage 4 — first motion, one servo (strings still off)

- [ ] Arm from the UI (profile valid → Parking → Ready).
- [ ] From the wizard's calibration step, move **one finger servo** at low
      speed; verify direction, travel, rest position.
- [ ] While it moves, press the E-stop: motion dies instantly (rail cut +
      `/OE` HIGH + firmware latch). `Reset` + re-arm afterwards works.
- [ ] Repeat the E-stop test with a **direct-GPIO servo** if any — this is the
      case only the power cut protects.

## Stage 5 — per-branch bring-up

For each branch (PCA board / string):

- [ ] Each servo on the branch reaches its rest and press/pluck positions
      (calibration steps), no binding, no chatter at rest (`disableAtRest`).
- [ ] Branch current at worst realistic case (chord on that string) within the
      branch fuse's continuous rating; note the peak.
- [ ] Branch voltage sag during the peak acceptable (< ~5 %); if not: bigger
      bulk cap, shorter/thicker wiring, or lower the per-board governor cap.

## Stage 6 — whole instrument

- [ ] Full-instrument stress pattern (dense chords across all strings);
      PSU current + sag within spec; nothing warm beyond reason (fuses,
      connectors, wiring).
- [ ] Wi-Fi loss during play: notes release, instrument stays armed.
- [ ] Kill one branch fuse (or unplug one PCA) during play: the affected
      strings fault (`readyDegraded`), the rest keeps playing; global panic
      only with no strings left.
- [ ] E-stop at full load: instant, complete stop; recovery = release + reset
      + re-arm.
- [ ] Only now: string the instrument and re-run stages 4–6 checks that
      involve motion, at low velocity first.

## Record

Keep with the machine: the wiring sheet (SVG export from the Wiring tab), fuse
ratings, measured idle/peak currents per branch, PSU model, capacitor values
fitted, and the date of this procedure.
