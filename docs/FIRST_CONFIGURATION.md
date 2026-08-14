# First configuration guide — Servo-Plucked-Strings-GMB

> Source: `SPECIFICATION.md` §8, §10, §26 (first configuration guide).
> Related documents: [`WEB_INTERFACE.md`](WEB_INTERFACE.md) · [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) · [`CALIBRATION.md`](CALIBRATION.md) · [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) · [`SAFETY.md`](SAFETY.md).

This guide walks a beginner from first power-on to the first note through the Web
interface. No code modification is needed.

The interface asks about your **machine**, not about the firmware: how many strings,
how the frets are actuated, how the string is played, how it is stopped. Everything
else — which servo exists, which PCA9685 board and channel it lands on, the GPIO map,
the timing, the MIDI mapping — is generated for you. Every one of those generated
decisions can still be changed, behind a *Change…* or an *Advanced* disclosure.

---

## 0. Before you begin

* Power the board and the servos on their recommended rails (a 5–6 V servo
  supply plus 3.3 V logic — there is no 24 V rail; see [`SAFETY.md`](SAFETY.md)
  §6). **Never power the servos from the ESP32 regulator.**
* At startup, the system is in a safe state: the PCA9685 outputs are disabled
  through `/OE`, servos are neutralized, MIDI queues are empty (see
  [`SAFETY.md`](SAFETY.md) §1). Nothing moves until the configuration has been
  validated and the instrument is armed.

---

## 1. Connecting to the interface

At first power-on, the ESP32 starts in **access-point mode**:

```text
Default SSID: Servo-Plucked-Strings-GMB
```

1. Connect your phone/computer to this Wi-Fi network.
2. Open the local address shown (or let the captive portal open it for you).
3. The interface opens on a **Welcome** screen — nothing is configured yet, so it
   takes you straight into creating an instrument:

   ```text
   Welcome
   Let's build your instrument.
   [ Use a template ]   [ Create a custom instrument ]
   ```

   *Use a template* offers ukulele / guitar / bass / mandolin / banjo and drops you
   into the designer with that tuning already loaded.

Once a configuration has been applied, **Instrument** (the playable neck) becomes the
home page and the welcome screen does not come back. The sidebar then holds three
pages — **Instrument**, **Configure** and **Wiring** — and the gear button (⚙,
top-right) holds the device settings, MIDI, advanced hardware, security, diagnostics
and the developer tools.

You can later switch to **client mode** (the ESP32 joins your network) from
⚙ → **Device**: pick a network from the scan, or type its name. The address is
obtained by DHCP — a fixed static IP is not currently configurable. If the connection
fails several times, the system automatically reverts to access-point mode. A long
press on the **BOOT** button forces the hotspot back on at any time.

The whole setup is **one ordered flow on the Configure page** — **five steps**:
**Instrument** → **Frets** → **Strings** → **Test** → **Finish**.

A **health bar** sits above every step (`🟢 No error` / `🟡 N recommendations` /
`🔴 N errors`), so you always know whether what you are building is valid; clicking
it jumps to the final check.

---

## 2. Step 1 — Instrument (the designer)

### 2.1 Identity and tuning

* **Starting point** — pick a **preset** (ukulele, guitar, bass, mandolin, banjo)
  to load a tuning + GM tags, or **Custom** for your own. The type only tags the
  name / GM program.
* **Strings & tuning** — **number of strings** (1–6), each string's
  **open-string MIDI note** (fret 0) and **highest reachable fret** (`maxFret`).
  A string is just an open pitch plus its top fret.

Changing the string count or a max fret re-generates the wiring **differentially**:
every servo that still exists mechanically keeps its full calibration and wiring, and
only genuinely new positions start from defaults. The tuning sets the note range
announced to General-Midi-Boop (see [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §3).

### 2.2 The three mechanical questions

This is the part only you can answer — and answering it is what builds the
instrument. Each card shows the **servo count it implies**.

**How are the frets actuated?**

| Choice | What it builds |
| ------ | -------------- |
| **One servo per fret** | every fret of every string gets its own finger — the most direct build, and the one that plays anything |
| **One servo for two frets** | a geared finger presses one of two neighbouring frets depending on which way it turns; halves the servo count on the low frets (see [`GEARED_FINGERS.md`](GEARED_FINGERS.md)). A *Pair the frets up to* field sets where the pairing stops |
| **Open strings only** | no fingers at all — each string plays its open note |
| **Custom** | keep the fret wiring exactly as it is; nothing is regenerated (pick this if you laid the fingers out by hand) |

**How is the string played?**

| Choice | What it builds |
| ------ | -------------- |
| **Single pick** | one plectrum per string, striking in one direction and returning to rest |
| **Back and forth pick** *(recommended)* | the plectrum strikes down, then up on the next note — faster repeats, no return travel between them |
| **Strum, up and down** | a strumming arm sweeping across the string in both directions |

**How is the string stopped?**

| Choice | What it builds |
| ------ | -------------- |
| **Let it ring** | nothing stops the string; it decays on its own |
| **The plectrum itself** | at Note Off the plectrum leans back onto the string and damps it — no extra servo |
| **A damper** | a dedicated felt/foam servo per string |
| **A descent servo** | the servo that lowers the plectrum stays leaning on the string to mute it |

If your strings currently disagree (an imported profile, or a per-string change made
later), the card says so and picking one applies it to every string.

### 2.3 What the software decided

The last card answers back:

```text
6 strings · 72 finger servos · 6 plectrums · 5 PCA9685 boards needed

Controller       ESP32-S3-DevKitC-1 ✓                     [ Change ]
Wiring           generated automatically ✓                [ View ]
MIDI             automatic ✓                              [ Configure MIDI… ]
Timing & power   recommended values ✓                     [ Adjust… ]
```

*Advanced options* holds the link to the advanced-hardware settings and the
**Danger zone** — *Reset wiring & calibration to defaults*, the only destructive
action in the flow.

---

## 3. Step 2 — Frets (frettes)

This step calibrates the **finger servos** — the part that presses the string against
a fret. A clickable **coverage strip** shows which frets carry a servo (geared marked
⚙). **Tap a fret** and you get exactly what you need to aim it:

```text
Fret 3 — G#3
  Rest position   [−]  35° [+]     finger lifted off the string
  Press position  [−]  71° [+]     finger pressing the fret
  [ → rest ] [ Test ] [ ▶ Play G#3 ] [ Next fret → ]
  The finger moves the wrong way?  [ Invert ]
  Wiring   PCA #2 · CH7 ✓                                 [ Change… ]
  ▸ Advanced
```

* the **angles** use precise **− / + steppers** (1° each) — every step drives the
  servo to that exact angle so it previews live;
* **Invert** flips the rotation direction (`inverted`) for a servo mounted the other
  way round — phrased as the symptom rather than as a checkbox called *Reverse
  rotation direction*;
* **Wiring** is a summary line; *Change…* opens the full source editor (PCA9685 board
  + I²C bus + channel, or a direct ESP32 GPIO);
* **Advanced** holds the per-fret **geared** toggle (pair this fret with its neighbour
  through a gear — `fretB` + `activeBUs`), `travelMs` / `settleMs`, and *Remove this
  finger servo*.

A **geared** servo shows one press angle **per fret**, and its rest sits at their
midpoint automatically (both fingers lifted); the paired fret's row shows *"paired
with fret N on one geared servo"* and is adjusted on the owner row.

**Arm the instrument first** — servo tests are refused until armed. *Group tests…*
folds out a bench that sweeps every fret of the string, or of all strings, in one
click. See [`CALIBRATION.md`](CALIBRATION.md).

---

## 4. Step 3 — Strings (grattage)

This step calibrates the **sounding servo** — the part that plucks the string. There
is one per string:

```text
Plectrum · string 1                                                 G4
  Rest position          [−]  90° [+]    plectrum resting against the string
  End of stroke          [−] 110° [+]    how far it sweeps past the string
  End of the return      [−]  70° [+]    (only when the movement alternates)
  [ Test stroke ] [ Test return stroke ] [ → rest ] [ ▶ Play the open string ]

  Movement    ( Single stroke ) ( Back and forth ) ( Strum )
  The plectrum moves the wrong way?  [ Invert ]
  Wiring   PCA #0 · CH11 ✓                                [ Change… ]
  ▸ Movement settings
```

*Movement settings* holds `travelMs`, `settleMs` and the two instrument-wide gesture
values: **stroke duration** (`strokeMs`) and **minimum strike depth**
(`minStrikePct`, so soft notes still reach the string).

**Extras** is one line per mechanism you do *not* have:

```text
+ Add a damper          + Add a descent servo
```

Adding one unfolds its own calibration (rest / active angles, a test row, *Invert*,
its wiring summary and its own movement settings — including the descent servo's
engage delay and the lower-to-play / raise-to-play engagement).

**Stopping the note** states the policy you chose on step 1 and shows only the angle
that policy needs (the plectrum's muting position when the plectrum damps). *Advanced*
holds the **mute hold** time and *also lean the descent servo on the string at Note
Off*.

Every string needs a sounding servo — the final check flags a string that has none.

---

## 5. Step 4 — Test

```text
✓ Configuration valid
✓ 41 servos generated across 4 strings

          [ Test the instrument automatically ]

The application will test:
  1. every finger, one fret at a time
  2. every plectrum
  3. each open string, through the real note path
  4. a few fretted notes per string
```

Arm the mechanics first. A live status line shows progress and a **Stop** button
cancels the sequence at any point. *Individual tests…* folds out the group tests
(open strings, all fingers, all plectrums, a scale) and a per-string quick play
offering **the middle fret actually equipped on that string**. Keep the **STOP**
(panic) button within reach (software panic — see [`SAFETY.md`](SAFETY.md) §3).

---

## 6. Step 5 — Finish

**Check** — either *Everything checks out*, or the problems in plain language:

```text
✖ String 3 — fret 6                                    [ Fix automatically ]
  Two actuators are wired to the same PCA9685 output, or the channel is out of
  range — this one has no usable output.
  ▸ Technical details
```

*Fix automatically* appears whenever the software can repair the problem itself
(move the servo to a free output, give a direct servo a free GPIO, wire the missing
`SDA`/`SCL`/`SERVO_OE`, add the missing plectrum). No actuator is enabled while
critical errors remain — the firmware `ProfileValidator` is authoritative.

**Wiring** — the generated harness in one glance:

```text
ESP32 → PCA #0 → string 1                              12/16 channels
ESP32 → PCA #1 → string 2                              10/16 channels
✓ No conflict                                     [ Open the wiring page ]
```

**Apply** — *Save and apply* validates the draft, activates it and publishes the new
capabilities. "Saved" means *active*: the interface follows the device through
parking → swap → re-arming and only confirms once the new profile really runs.
*Discard changes* asks for confirmation first.

Once applied, the step ends on the **commissioning** call-to-action — do that before
the whole rig gets current.

---

## 7. Wiring — the generated harness

Pin assignment is **not a setup step**. The **Wiring** page shows what was generated
and walks the first power-up:

| Sub-tab | What you do there |
| ------- | ----------------- |
| **Diagram** | read the generated ESP32 + PCA9685 harness (boards, addresses, per-pin string·role), check the live wiring warnings, download the SVG, and follow the **Power wiring** advice (star wiring, one bulk cap per board, 100 nF ceramic, fail-safe `/OE`) |
| **Commissioning** | walk the staged power-up checklist before the first note; each stage is a gate that unlocks the next |

There are **no per-string STEP / DIR / HOME / ENABLE pins**. A direct-GPIO servo
carries its own pin in its servo entry (behind *Change…* on the Frets or Strings
step), not here.

---

## 8. ⚙ Settings — everything the software decided for you

Nothing below is needed for a first instrument. It is there for the day your hardware
differs from the recommended build, or when you are diagnosing a real installation.

| Tab | Contents |
| --- | -------- |
| **Device** | the current Wi-Fi connection and *Change network*, the fallback hotspot, and — folded — the mode/SSID/hostname and the stored-credential erasure |
| **MIDI** | *Automatic* by default. Folded: channel (**1–16**), Omni, velocity curve, transpose, chord window, sustain pedal, saturation strategy; the General-Midi-Boop tablature preset (`CC20` = string, `CC21` = fret, hybrid mode) and every CC-level setting |
| **Advanced hardware** | the ESP32 **board** + native-USB reserve · the **PCA9685 / I²C** capacity meter and second-bus split · **Responsiveness** (Fast / Balanced / Limited power supply, with every exact timing and governor value under *Exact values*) · the **GPIO pins** grid, auto-assign and the **hardware E-stop** declaration · **I²C addressing & pull-ups** · the **Power & safety** dossier and current estimator |
| **Security** | the admin token and the network-MIDI source posture |
| **Diagnostics** | the live MIDI monitor and the integrated note tester |
| **Developer** | GMB identity & capabilities (SysEx) and the SysEx tester |

**Assign automatically** (Advanced hardware → GPIO pins) places only the board-level
signals a PCA9685 needs: I²C `SDA = 40`, `SCL = 41` and the PCA `/OE` safety line
`SERVO_OE = 47`. See [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md),
[`../hardware/POWER_AND_SAFETY.md`](../hardware/POWER_AND_SAFETY.md),
[`../hardware/I2C_PCA9685.md`](../hardware/I2C_PCA9685.md) and
[`../hardware/COMMISSIONING.md`](../hardware/COMMISSIONING.md).

---

## 9. Connecting General-Midi-Boop (optional)

The automatic MIDI setup already speaks General-Midi-Boop tablature, so usually there
is nothing to do. If you changed it:

1. ⚙ → **MIDI** → *String / fret selection* → **Apply the General-Midi-Boop preset**
   (`CC20` = string, `CC21` = fret, hybrid mode).
2. ⚙ → **Developer** → keep *Enable GMB detection* on and press **Publish
   capabilities**.

GMB then discovers the instrument (identity, capabilities, strings) via SysEx. The
same tab carries a **SysEx tester** (descriptor, identity, capabilities, string
config, full discovery) to check the exchange. See
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §2–3 and
[`WEB_INTERFACE.md`](WEB_INTERFACE.md) §5.6.

---

## 10. Save and get going

**Save and apply** — from the Finish step, or from the bar that appears as soon as
something is edited — validates the draft, activates it and publishes the new
capabilities. The confirmation is `Configuration applied ✓`.

Profile **slots** (8 of them, with export / import / startup slot) exist in the
firmware and in the REST API, but are deliberately **not exposed** in the interface —
saving activates the profile in place. The Wi-Fi password is never included in an
export.

Enjoy your first note!
