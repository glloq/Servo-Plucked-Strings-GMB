# Power & safety — reference electrical circuit

This is the **reference power-distribution and safety architecture** of the
servo-per-fret build: the one circuit the firmware, the bill of materials and the
web interface all describe. Wire-by-wire connections live in
[`wiring/WIRING.md`](wiring/WIRING.md); the I²C specifics in
[`I2C_PCA9685.md`](I2C_PCA9685.md); the guided power-up procedure in
[`COMMISSIONING.md`](COMMISSIONING.md). The firmware's *behaviour* on stop/panic
is [`../docs/SAFETY.md`](../docs/SAFETY.md).

The web interface applies this circuit live to your configuration (*Wiring &
GPIO → Power & safety*): declare what is physically fitted (pull-up, contactor,
fuses — stored with the profile), see the power tree with undeclared elements
dashed, and size fuses/PSU/capacitors from your servo currents.

Three schematic sheets accompany this document
([`schematics/`](schematics/README.md)):

* [`01-power-distribution`](schematics/01-power-distribution.md)
* [`02-estop-and-servo-enable`](schematics/02-estop-and-servo-enable.md)
* [`03-esp32-pca9685-one-string`](schematics/03-esp32-pca9685-one-string.md)

## 0. Principles

1. **The natural electrical state is OFF.** Every authorisation — servo power,
   PCA9685 outputs — must be *actively maintained*. An absent ESP32, a cut
   cable, a firmware crash, an open E-stop chain must each, alone, return the
   machine to the safe state.
2. **A software stop is a convenience, not a safety function.** `POST
   /api/panic`, CC120/123 and the web STOP button all depend on a running
   firmware and a live network. The emergency stop is a **hardware chain**.
3. **`/OE` alone is not an E-stop.** The PCA9685 output-enable neutralises PCA
   servos, but does nothing for **direct-GPIO servos** and nothing if a board's
   PWM latch is already driving a stalled servo against an obstacle. The E-stop
   chain must also **remove servo power**.
4. **One machine = one documented circuit.** Fuses, wire gauges and capacitor
   values depend on *your* servo count and models; this document gives the
   structure and the sizing method, not universal numbers.

## 1. Power tree (reference)

Two independent supplies, one common ground:

| Rail | Source | Feeds |
| ---- | ------ | ----- |
| **5–6 V servo rail** | dedicated PSU/BEC, sized to the servo count | every servo (PCA9685 `V+` and direct-GPIO servos) — **never** the ESP32 regulator |
| **5 V / USB logic** | USB or a small 5 V supply | ESP32-S3 (its on-board 3.3 V regulator), PCA9685 `VCC` (3.3 V logic) |

```text
LOGIC 5 V / USB ────────────────► ESP32-S3 ── 3V3 ──► PCA9685 VCC, /OE pull-up
                                                     (logic only, never a servo)

SERVO PSU 5–6 V
      │
 [F0  main fuse]
      │
 [S1  master switch]                    (mandatory on a fixed installation)
      │
 [K1  E-stop contactor / power switch]  ◄── E-stop chain, contact NC #1 (§2)
      │
      ├─ star distribution block ───────────────────────────────┐
      │                                                         │
 [F1 branch fuse]   [F2]          [F3]         …          [F(n) direct-servo rail]
      │              │             │                            │
  [C1 bulk cap]  [C2 bulk cap] [C3 bulk cap]                [C(n) bulk cap]
      │              │             │                            │
  PCA9685 #0     PCA9685 #1    PCA9685 #2                 direct-GPIO servos
  (string 1)     (string 2)    (string 3)
      │              │             │
   servos S1      servos S2     servos S3

COMMON GROUND: logic GND and servo GND tied at ONE point (the distribution block).
```

Rules:

* **Star wiring** from the distribution block: one direct feed pair per branch
  (per PCA9685 and one for the direct-servo rail). Never daisy-chain `V+` from
  board to board — one branch's inrush would sag its neighbours.
* **F0 main fuse** at the PSU output, rated for the whole instrument
  (mandatory). **F1…Fn branch fuses** at the distribution block, rated per
  branch (strongly recommended): a wiring fault on one string blows one branch
  instead of taking the instrument down, and localises the fault immediately.
* **Reverse-polarity protection** (P-MOSFET preferred, series Schottky
  acceptable at low current) between the PSU and F0 when the supply connector
  can be miswired.
* **TVS diode** across the servo rail after K1 (recommended) to clamp the
  inductive spikes of dozens of motors.
* **Lockable / keyed connectors** on every power branch, sized with headroom
  over the branch fuse rating.
* **Common ground at one point.** The servo return currents must not flow
  through the logic ground: tie the two grounds at the distribution block only,
  and give the I²C/`/OE` harness its own ground return alongside the signals.

### 1.1 Sizing method (per build — no universal numbers)

For each branch, from the servo datasheets:

```text
I_idle    idle current            (PWM held, no motion)
I_move    typical moving current
I_stall   stall / peak current    (worst case, start of motion or blocked)
```

* **Branch fuse**: above the branch's realistic worst case — the
  `power.maxConcurrentPerBoard` governor cap × `I_stall` of the largest servo,
  plus the idle draw of the rest — below the branch wiring's ampacity.
* **PSU**: ≥ Σ (per-branch worst case actually reachable under the global
  `power.maxConcurrentMoves` cap), with 30–50 % headroom. **The firmware's
  governor spreads start-up peaks but is *not* a substitute for a properly
  sized supply** — it bounds simultaneity, not physics.
* **Wire gauge**: per-branch current over the actual run length, sized for
  < 5 % voltage drop at worst case (at 6 V, every 0.1 Ω costs 0.6 V at 6 A).

### 1.2 Bulk capacitors — starting values, then measure

Each PCA9685 branch gets a **bulk electrolytic across `V+`/GND at the board**
plus a **100 nF ceramic**. The often-quoted table:

```text
~4 micro-servos starting together  → 1000–2200 µF
~8                                 → 2200–4700 µF
~16                                → 4700–10000 µF
```

is a set of **empirical starting values for SG90-class micro-servos** — not an
electrical law. Two strong digital servos out-draw eight micro-servos. Size
from the indicative relation:

```text
C ≈ I × Δt / ΔV

I  : summed start-up current of the servos that can start together (governor cap)
Δt : PSU + wiring response time to the step (~1–10 ms typical)
ΔV : sag you can accept on the branch (e.g. 0.3 V)
```

then **confirm at the bench** with a scope on the branch rail during a chord
(commissioning §[`COMMISSIONING.md`](COMMISSIONING.md)). Electrolytics on a
6 V rail should be rated 10 V or more.

## 2. The emergency stop — a subsystem, not a switch

The reference E-stop is a **latching mushroom-head button (twist/pull to
release) with at least two independent NC contacts**:

| Contact | Function |
| ------- | -------- |
| **NC #1 — power** | in series with the coil of contactor/relay **K1**: pressing the button (or cutting the chain wiring) drops K1 and **removes the 5–6 V servo rail** |
| **NC #2 — status** | closes the **`ESTOP` input loop** of the ESP32 so the firmware *knows* the chain state and latches `EmergencyStop` (§4) |
| NC #3 — optional | in series with the `/OE` enable stage (§3) so the PCA outputs cannot be re-enabled while the chain is open |

```text
                          E-STOP (latching, NC contacts)
                          ┌────────────┬───────────────┐
                          │ NC #1      │ NC #2         │ NC #3 (optional)
  5–6 V ── K1 coil ───────┘            │               │
           (drops the servo rail)      │               │
                                       │               └── in series with the
  ESP32 ESTOP input ◄── NC loop to GND ┘                   /OE enable stage (§3)
```

Rules:

* **The button never switches the servo current itself.** Tens of amps of DC
  belong on **K1**, a contactor/relay **rated for DC** at the rail current
  (DC arcs are much harder to break than AC — check the DC rating, not the AC
  one). The button only switches K1's coil and the two signal loops.
* **Freewheel diode** across K1's coil if it is a DC coil without built-in
  suppression.
* **NC everywhere in the chain**: a broken wire, an unplugged connector or a
  corroded contact *opens* the chain and stops the machine, instead of
  silently disabling the E-stop.
* K1 may be combined with the master switch S1 in a start/stop contactor
  arrangement (start push-button + self-holding contact) so the machine also
  does not restart on its own after a power dip.

**Regulatory note.** For a personal bench prototype this chain already gives
real hardware independence from the software. For a machine exposed to the
public, to workers, or heading to certification, run a risk assessment and
design the E-stop function per **ISO 13850** (emergency-stop principles) and
**IEC 60204-1** (electrical implementation), with an appropriately rated
safety chain. That work is out of scope here but the two-NC-contact
architecture above is the right starting shape.

## 3. `/OE` — fail-safe output enable

The PCA9685's `/OE` pin is **active-low** (LOW = outputs on) and has an
**internal weak pull-down**: *a floating `/OE` bus means outputs ENABLED*.
Left unwired, an unplugged ESP32 or a cut harness silently enables every PCA
output. Therefore:

### Level 0 — mandatory in every build

```text
3.3 V ── [R_pu 10 kΩ] ──●── /OE bus ──► PCA #0 /OE, PCA #1 /OE, … (chained)
                        │
             ESP32 SERVO_OE GPIO (drives LOW to enable, HIGH to disable)
```

* **External pull-up (≈10 kΩ) from the `/OE` bus to 3.3 V.** During reset and
  boot the ESP32 GPIO is high-impedance: the pull-up (which outweighs the
  chip's weak pull-down) holds `/OE` HIGH and the outputs stay **off** with the
  ESP32 absent, resetting, or the harness unplugged.
* The firmware keeps today's contract: `SERVO_OE` LOW = enabled, HIGH (or
  high-Z + pull-up) = disabled; it holds the pin HIGH from boot until the
  profile is validated and armed.
* **Never wire a switch or the E-stop so it *forces* `/OE` to 3.3 V while the
  GPIO can drive it LOW** — that is a direct short through the GPIO
  (contention). Inhibition belongs in a gated stage (level 1) or simply in the
  power path (§2), never in a hard tie to a rail.

### Level 1 — recommended: gated, non-inverting enable stage

To let the E-stop chain (NC #3) **physically forbid enabling** without touching
firmware polarity and without contention, buffer the command through a
two-transistor open-drain stage:

```text
        3.3 V              3.3 V                3.3 V
          │                  │                    │
      [R4 47k]           [R3 10k]            [R_pu 10k]
          │                  │                    │
SERVO_OE ─[R1 4.7k]─●     A ─●────[R2 4.7k]─► Q2 base
                    │        │                    │
                Q1 base   Q1 collector       Q2 collector ──► /OE bus ─► every PCA /OE
                    │     (= node A)              │
                Q1 (NPN)                      Q2 (NPN)
                    │E                            │E
                   GND                    NC #3 (E-stop chain)
                                                  │
                                                 GND
```

* **Q1** inverts the GPIO command: `R1` in series from `SERVO_OE`, and **`R4`
  pulls Q1's base up to 3.3 V** so an absent / resetting / unplugged ESP32
  (pin high-Z) leaves Q1 **on** — the safe default. Node A (Q1's collector)
  is pulled up by `R3`.
* **Q2** inverts again onto the bus: base fed from node A, collector on the
  `/OE` bus (open collector against `R_pu`), **emitter returned to ground
  through the E-stop chain's NC #3 contact**.

Behaviour (truth table):

```text
SERVO_OE LOW  + chain closed → Q1 off → node A HIGH → Q2 on  → /OE LOW  → ENABLED
SERVO_OE HIGH                → Q1 on  → node A LOW  → Q2 off → /OE HIGH → disabled
SERVO_OE high-Z (reset / ESP absent / harness cut)
                             → R4 turns Q1 on → node A LOW  → Q2 off    → disabled
E-stop chain open (NC #3)    → Q2 has no ground return      → /OE HIGH  → DISABLED
```

The stage is **non-inverting** (GPIO LOW still means "enable"), so the existing
firmware drives it unchanged; and with NC #3 open, *even a live, buggy ESP32
cannot enable the PCA outputs*. A small N-MOSFET pair wired the same way works
too.

> A **single**-transistor open-drain stage would invert the command sense
> (GPIO HIGH = enable). The current firmware has no `/OE`-inversion option, so
> do not use a one-transistor stage.

With a **split `/OE`** (`SERVO_OE2` for I²C bus 1), duplicate the pull-up and
the stage per bus; the E-stop chain contact gates both.

### What `/OE` does *not* cover

Direct-GPIO servos have no output-enable: on `hardStop` the firmware detaches
their PWM, but the **only hardware-grade stop for them is the K1 power cut**
(§2). This is why the E-stop must act on the rail, not only on `/OE`.

## 4. The `ESTOP` firmware input

The firmware reads an optional **`ESTOP`** pin (declared in the web interface,
*Wiring & GPIO → Emergency stop input*; carried in the profile like every other
signal). It is a `SafetyInput`: any readable, interrupt-capable, non-strapping
GPIO, sampled with `INPUT_PULLUP` at the top of every loop, debounced, and it
latches `EmergencyStop` (recover with `POST /api/reset` after the button is
released — see [`../docs/SAFETY.md`](../docs/SAFETY.md)).

Two contact wirings, selected in the profile (`board.estopNormallyClosed`):

| Wiring | Level = STOP | Failure mode |
| ------ | ------------ | ------------ |
| **NC loop to GND (recommended)** | **HIGH** — a press, a cut wire, an unplugged connector all open the loop and the pull-up reads STOP | fail-safe |
| NO button to GND (legacy) | LOW | a broken wire silently disables the E-stop input — keep only on existing wired builds |

The `ESTOP` input is **status, not actuation**: it tells the firmware the chain
opened so it can latch, log and refuse arming. The actual muscle is K1 (§2)
and the `/OE` chain (§3), which work with the firmware dead.

## 5. BOM deltas

The safety/power items and their status live in the bill of materials —
[`BOM.md`](BOM.md) §Power & safety. Anything marked *mandatory* there is part
of this reference circuit, not an option.
