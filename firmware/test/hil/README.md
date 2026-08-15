# Hardware-in-the-loop (HIL) bench validation

> Related: [`../../../hardware/COMMISSIONING.md`](../../../hardware/COMMISSIONING.md) ·
> [`../../../hardware/POWER_AND_SAFETY.md`](../../../hardware/POWER_AND_SAFETY.md) ·
> [`../../../docs/SAFETY.md`](../../../docs/SAFETY.md)

## Why this exists

The CI proves a lot and cannot prove the thing that matters most. It compiles the
firmware for three ESP32 targets, runs ~290 host tests under ASan/UBSan, checks
every profile through the real validator and exercises the web UI's logic. None
of that can tell you that a servo moved, that `/OE` really cut the outputs, or
that pulling the I²C connector mid-chord is survivable.

This directory holds the bench campaign that closes that gap.

**Status: the harness has never been run against hardware.** It was written
against the firmware's API contract, not against a device. Budget the first bench
session for bringing the harness up as well as the firmware, and when an
expectation fails, first ask whether the harness is wrong about the real device.

Its *logic*, however, is tested on every CI run — see **Self-check** below. The
first version of this harness shipped with three defects that a syntax check
could not see (wrong auth header, an assertion that passed on every `202`, and a
command timeout counted as a pass), which is exactly why that self-check exists.

## Bench

```text
                    ┌──────────────────────┐
   bench laptop ───►│  ESP32 (Wi-Fi)       │
   run_hil.py       │                      │
                    │  SDA/SCL ────────────┼──► PCA9685 @ 0x40
                    │  SERVO_OE ───────────┼──►   /OE   ──► scope / logic analyser
                    │  ESTOP ──────────────┼──◄ E-stop (NC loop recommended)
                    └──────────┬───────────┘
                               │ common GND
                    ┌──────────┴───────────┐
                    │ 5–6 V servo supply   │──► 2–4 servos on the PCA9685
                    │ (separate rail)      │    + bulk cap at the board
                    └──────────────────────┘
```

Non-negotiable: **the servos never run off the ESP32 regulator**, and the two
supplies share a ground. Wire `/OE` fail-safe (pull-up + E-stop chain) as in
`hardware/POWER_AND_SAFETY.md` — the whole campaign assumes that a de-energised
`/OE` line means "outputs off".

Use a small profile (one string, 2–4 servos). Everything the campaign checks
scales down; a full instrument only makes the failures harder to see.

## Running it

```bash
python3 run_hil.py --list                       # what it covers
python3 run_hil.py --host gmb-ukulele.local     # full campaign
python3 run_hil.py --host 192.168.1.42 --token $ADMIN_TOKEN
python3 run_hil.py --host … --only arming,estop # one scenario at a time
python3 run_hil.py --host … --unattended        # API-only subset, no prompts
```

Standard library only — nothing to install on a bench laptop. Exit code 0 when
every executed check passed; a JSON report lands in `hil-report.json` and belongs
in the commissioning record.

The run is **semi-automated**: everything observable through the REST API is
asserted by the script, and everything that needs a hand on a connector or an eye
on a scope is prompted — after which its *effect* is asserted automatically. A
prompt can always be skipped with `s`; skipped checks are reported as skipped,
never as passed.

## The REST contract it speaks

Getting this wrong is how a harness silently proves nothing, so it is worth
stating:

| Route | Answer | How the outcome is known |
| ----- | ------ | ------------------------ |
| `POST /api/reset` | **202** + `commandId` | `GET /api/commands?id=N` → succeeded / refused / failed / cancelled |
| `POST /api/test/note` | **202** + `commandId` | same — the *safety* decision is taken later, on the loop |
| `PUT /api/profile` | **202** + `commandId` | same |
| `POST /api/test/servo` | **409** when not armed, else 202 | refused at HTTP, or by command outcome |
| `POST /api/panic` | **200**, no command | it sets a flag; observe `/api/status` |
| any write, token set | **401** without `X-GMB-Token` | — |

Two consequences the harness now respects, and did not before:

* **an HTTP code alone proves nothing about a mechanical command.** Asserting
  `status != 200` to show a note was refused during an E-stop passes on every
  single `202`, whatever the device then does. The outcome has to be followed to
  `refused`.
* **a command timeout is a FAILURE.** It means the command never reached a
  terminal state, which is precisely the condition a bench run exists to surface.

## Self-check (CI)

```bash
python3 selfcheck.py        # exit 0 = the harness is trustworthy
```

`mock_device.py` reproduces the semantics of `platform/esp32/WebApi.cpp` — the
202-plus-`commandId` contract, `X-GMB-Token`, the 200 on `/api/panic`, refusal at
the command layer rather than at HTTP. `selfcheck.py` runs the **real** harness
against it and asserts both halves of what a harness must do:

* against a well-behaved device, every automated check passes;
* against a deliberately misbehaving one (`--misbehave never-stops` /
  `slow-command` / `wrong-token`), the harness **fails, on the right check**.

Verified by reintroducing the original defects: with the old `X-Admin-Token`
header the authenticated run fails 12 checks, and with the old
`status != 200` assertion the harness stops catching a device that keeps playing
after a panic.

`--wait-scale` shrinks the wait budgets for the self-check (the mock answers
instantly). **Leave it at 1.0 on hardware** — the real budgets are sized on a
double park plus arming.

## What it covers

| Scenario | What it proves | Automated | Manual |
| -------- | -------------- | --------- | ------ |
| `reachable` | the device answers, a profile is loaded, every PCA9685 ACKs | ✅ | — |
| `boot_safe` | an invalid profile boots to `CONFIG_SAFE` and drives nothing | state, servo-pulse counter | load a bad profile, reboot, watch for twitch |
| `arming` | the arming park runs **through the governor** and only then reports Ready | command outcome, phase, move counters, move mix | watch the park is staggered |
| `oe` | `/OE` falls only onto silent channels, and rises instantly on panic | — | scope `/OE` + one channel |
| `play` | single notes, a synchronised chord, 20 fast repeats with no dropped event and a responsive loop | HTTP, dropped events, faults, loop latency | chord sounds as one attack |
| `loop_latency` | **audit P1** — no network path stalls `loop()`; the AP switch costs nothing like the old `delay(100)` | loop max-latency before/after a scan and a hotspot switch | reconnect to the AP |
| `estop` | the E-stop leaves Ready, kills the servos, refuses notes, **lands even while the radio is busy**, and re-arms | state, note refusal, re-arm | press / release, press during a scan |
| `pca_loss` | **audit P1** — a board unplugged mid-play is caught **on the write**, faults the string and degrades the instrument | health flag, fault counter, state, user-facing fault text | unplug SDA/SCL |
| `i2c_wedge` | a bus held low neither hangs `loop()` nor the web layer | web still answers, loop latency, health | short SDA to GND |
| `servo_supply` | dropping the servo rail does not brown out the controller | reachability, reset reason | cut and restore the rail |
| `profile_swap` | a swap **during a sounding note** lifts the old fingers first and re-arms | HTTP, command outcome, phase | no finger left pressed |
| `panic` | `POST /api/panic` leaves Ready, refuses notes, and re-arms cleanly | state, note refusal, re-arm | — |
| `wifi_loss` | an outage cancels pending work, keeps the servos parked and recovers | reconnect counter, phase | power-cycle the router |
| `reset` | a bare reset comes back safe, then arms itself | reachability, reset reason, phase | press RESET, watch for a jump |

The three scenarios in bold (`loop_latency`, `estop` during traffic, `pca_loss`)
are the bench counterpart of the firmware audit's P1 fixes — they are the reason
this harness exists in this shape.

## Order, and when to stop

Run `hardware/COMMISSIONING.md` first: this campaign assumes a rig that has
already been brought up stage by stage. Then run the scenarios in listed order —
`reachable` gates everything else, and the destructive scenarios (`pca_loss`,
`i2c_wedge`, `servo_supply`) come after the ones that establish the instrument
plays correctly, so a failure there is unambiguous.

**Stop the campaign** if a servo moves when nothing asked it to, if `/OE` is ever
low while the device reports itself not armed, or if the E-stop fails to land.
Those three are not "a failed check": they are a safety defect, and the rig
should be de-energised before anything else is investigated.

## Recording the result

Keep `hil-report.json` with the build it was run against:

```bash
python3 run_hil.py --host gmb-ukulele.local \
    --report "hil-$(git rev-parse --short HEAD).json"
```

A campaign is only meaningful for the firmware revision it ran on. Re-run at
least `arming`, `estop`, `pca_loss` and `play` after any change to `ServoBank`,
`SafetySupervisor`, `PlaybackScheduler` or the `loop()` ordering.
