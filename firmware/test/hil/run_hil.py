#!/usr/bin/env python3
"""Hardware-in-the-loop test driver for Servo-Plucked-Strings-GMB.

WHAT THIS IS FOR
    The CI proves the code compiles, that the pure logic behaves and that every
    profile parses. It cannot prove that a servo moved, that /OE actually cut the
    outputs, or that pulling the I2C connector mid-chord is survivable. This
    script drives a REAL device over its REST API and checks what it reports,
    prompting for the physical actions it cannot perform itself.

    It is therefore SEMI-automated: everything observable through the API is
    asserted automatically; everything that needs a hand on a connector (or an
    eye on a scope) is prompted, and its EFFECT is then asserted automatically.

    ⚠ This harness has never been run against hardware — there was none available
      when it was written. Treat the first bench session as bringing the harness
      up as much as the firmware, and fix the expectations that turn out to be
      wrong about the real device rather than assuming the device is wrong.

BENCH
    ESP32 (S3-DevKitC-1 / WROOM-32 / DevKit v1)
      ├── PCA9685 at 0x40 on SDA/SCL, /OE on the profile's SERVO_OE pin
      │     ├── 2-4 servos on their own 5-6 V supply (NOT the ESP32 regulator)
      │     └── /OE probed with a scope or a logic analyser
      ├── E-stop wired per hardware/POWER_AND_SAFETY.md (NC loop recommended)
      └── the ESP32 reachable over Wi-Fi (station mode is easiest for a bench)

USAGE
    python3 run_hil.py --host gmb-ukulele.local [--token ADMIN_TOKEN]
    python3 run_hil.py --host 192.168.1.42 --only arming,estop
    python3 run_hil.py --host … --unattended     # skip every prompted step

    Exit code 0 when every executed check passed. A JSON report is written to
    hil-report.json for the commissioning record.

    Standard library only — no pip install on a bench laptop.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- #
# transport
# --------------------------------------------------------------------------- #


class Device:
    """Thin REST client for the instrument."""

    def __init__(self, host, token=None, timeout=5.0, wait_scale=1.0):
        self.base = host if host.startswith("http") else "http://" + host
        self.token = token
        self.timeout = timeout
        # Scales every wait_state / wait_command budget. 1.0 on a bench; the CI
        # self-check runs at 0.05 so the deliberate "never resolves" case costs
        # seconds instead of a minute. Never scale this on real hardware: the
        # budgets are sized on a double park plus arming.
        self.wait_scale = wait_scale

    def _request(self, method, path, body=None):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            # The firmware reads X-GMB-Token (WebApi::authOk). The harness used to
            # send X-Admin-Token, so --token silently authorised nothing and every
            # protected call came back 401.
            req.add_header("X-GMB-Token", self.token)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read().decode() or "{}"
                status = r.status
        except urllib.error.HTTPError as e:
            # 401 / 409 / 422 / 503 are real answers the checks reason about, not
            # transport failures — urlopen raises on them, so unwrap it here.
            raw = (e.read().decode() or "{}")
            status = e.code
        try:
            return status, json.loads(raw)
        except json.JSONDecodeError:
            return status, {"raw": raw}

    def get(self, path):
        return self._request("GET", path)

    def post(self, path, body=None):
        return self._request("POST", path, body if body is not None else {})

    def put(self, path, body):
        return self._request("PUT", path, body)

    # -- convenience -------------------------------------------------------- #

    def status(self):
        return self.get("/api/status")[1]

    def diagnostics(self):
        return self.get("/api/diagnostics")[1]

    def profile(self):
        return self.get("/api/profile")[1]

    def wait_state(self, wanted, timeout=30.0, poll=0.25):
        """Wait until /api/status state is one of `wanted`. Returns the last state."""
        wanted = {w.lower() for w in wanted}
        deadline = time.time() + timeout * self.wait_scale
        last = None
        while time.time() < deadline:
            try:
                last = str(self.status().get("state", "")).lower()
            except Exception:
                last = None
            if last in wanted:
                return last
            time.sleep(poll)
        return last

    TERMINAL = ("succeeded", "refused", "failed", "cancelled")

    def wait_command(self, command_id, timeout=40.0, poll=0.25):
        """Poll a 202-accepted command to its terminal state.

        Returns one of succeeded / refused / failed / cancelled, or "timeout" —
        which is NEVER a success. A missing id means the device did not queue
        anything, which is a result in itself ("not-queued"), not an implicit OK.
        """
        if not command_id:
            return "not-queued"
        deadline = time.time() + timeout * self.wait_scale
        while time.time() < deadline:
            st = str(self.get("/api/commands?id=%d" % command_id)[1].get("state", ""))
            if st in self.TERMINAL:
                return st
            time.sleep(poll)
        return "timeout"

    def command(self, method, path, body=None, timeout=40.0):
        """Issue a QUEUED command and follow it to its real outcome.

        Every mechanical route (/api/reset, /api/test/note, /api/test/servo,
        PUT /api/profile) answers **202 Accepted** with a commandId and decides
        later, on the loop. Checking the HTTP code alone proves only that the
        request was parsed — the harness used to assert `status != 200` to show a
        note was "refused during the E-stop", which passes on every 202 whatever
        the device then does with it.

        Returns (status, body, outcome).
        """
        status, body_out = (self.put(path, body) if method == "PUT"
                            else self.post(path, body))
        if status != 202:
            # 401 unauthorised, 409 not armed, 503 queue full, 422 invalid… all
            # terminal refusals in their own right.
            return status, body_out, "http-%d" % status
        return status, body_out, self.wait_command(body_out.get("commandId"), timeout)


# --------------------------------------------------------------------------- #
# harness
# --------------------------------------------------------------------------- #

RESET = "\033[0m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BOLD = "\033[1m"


class Harness:
    def __init__(self, dev, unattended=False):
        self.dev = dev
        self.unattended = unattended
        self.results = []          # {scenario, check, ok, detail}
        self.scenario = "-"
        self.failures = 0
        self.skipped = 0

    def check(self, ok, label, detail=""):
        self.results.append(
            {"scenario": self.scenario, "check": label, "ok": bool(ok), "detail": detail}
        )
        if not ok:
            self.failures += 1
        mark = (GREEN + "PASS" + RESET) if ok else (RED + "FAIL" + RESET)
        print("   [%s] %s%s" % (mark, label, (" — " + detail) if detail else ""))
        return bool(ok)

    def skip(self, label, why):
        self.skipped += 1
        self.results.append(
            {"scenario": self.scenario, "check": label, "ok": None, "detail": why}
        )
        print("   [%sSKIP%s] %s — %s" % (YELLOW, RESET, label, why))

    def manual(self, instruction):
        """Ask the operator to do something physical. False when skipped."""
        if self.unattended:
            self.skip("manual: " + instruction, "unattended run")
            return False
        print("\n   %s>>> %s%s" % (BOLD, instruction, RESET))
        answer = input("   Press ENTER when done, or 's' to skip this step: ").strip()
        return answer.lower() != "s"

    def observe(self, question):
        """Ask the operator what they SAW. None when skipped."""
        if self.unattended:
            self.skip("observation: " + question, "unattended run")
            return None
        print("\n   %s>>> %s%s" % (BOLD, question, RESET))
        answer = input("   [y]es / [n]o / [s]kip: ").strip().lower()
        if answer.startswith("s"):
            self.skip("observation: " + question, "operator skipped")
            return None
        return answer.startswith("y")

    def begin(self, name, title):
        self.scenario = name
        print("\n%s== %s ==%s" % (BOLD, title, RESET))


# --------------------------------------------------------------------------- #
# scenarios — the audit's HIL list
# --------------------------------------------------------------------------- #


def sc_reachable(h):
    """The device answers and reports a coherent state."""
    h.begin("reachable", "Reachability and baseline state")
    try:
        st = h.dev.status()
    except (urllib.error.URLError, OSError) as e:
        h.check(False, "GET /api/status", "unreachable: %s" % e)
        return False
    h.check("state" in st, "status carries a state", str(st.get("state")))
    diag = h.dev.diagnostics()
    h.check("uptimeMs" in diag, "diagnostics available",
            "uptime %s ms, reset: %s" % (diag.get("uptimeMs"), diag.get("resetReason")))
    prof = h.dev.profile()
    h.check(isinstance(prof.get("servos"), list) and prof["servos"],
            "a profile with servos is loaded",
            "%s, %d servo(s)" % (prof.get("instrument", {}).get("name"),
                                 len(prof.get("servos", []))))
    pca = diag.get("pca", {})
    h.check(pca.get("healthy", True), "every PCA9685 ACKs",
            "failed board: %s" % pca.get("failedBoard", "none"))
    return True


def sc_boot_safe(h):
    """Boot with no valid profile must stay in CONFIG_SAFE and drive nothing."""
    h.begin("boot_safe", "Boot without a valid profile (fail-safe)")
    if not h.manual("Load an INVALID profile (e.g. two servos on the same PCA "
                    "channel) and reboot the ESP32"):
        return
    state = h.dev.wait_state({"configsafe", "config_safe"}, timeout=45)
    h.check(state in ("configsafe", "config_safe"),
            "the device stays in CONFIG_SAFE", "state=%s" % state)
    moved = h.dev.diagnostics().get("servoMoves", 0)
    time.sleep(2)
    h.check(h.dev.diagnostics().get("servoMoves", 0) == moved,
            "no servo pulse is emitted in CONFIG_SAFE")
    st = h.dev.status()
    h.check(str(st.get("safety", "")).lower() != "armed",
            "safety is not armed", "safety=%s" % st.get("safety"))
    seen = h.observe("Did every servo stay completely still (no twitch at boot)?")
    if seen is not None:
        h.check(seen, "no mechanical movement at boot")
    h.manual("Restore a VALID profile and reboot before continuing")
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)


def sc_arming(h):
    """Arming parks the servos under the governor and only then reports Ready."""
    h.begin("arming", "Arming and governed parking")
    before = h.dev.diagnostics()
    status, _, outcome = h.dev.command("POST", "/api/reset", timeout=60)
    h.check(status == 202, "POST /api/reset is queued (202)", "HTTP %d" % status)
    # A timeout is NOT a pass: it means the arming never reached a terminal state,
    # which is exactly the case a bench run has to surface.
    h.check(outcome == "succeeded", "the arming command SUCCEEDED",
            "outcome=%s" % outcome)
    state = h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    h.check(state in ("ready", "readydegraded"), "the device reaches Ready",
            "state=%s" % state)
    after = h.dev.diagnostics()
    h.check(after.get("servoMoves", 0) > before.get("servoMoves", 0),
            "the park actually wrote servo pulses",
            "%d -> %d" % (before.get("servoMoves", 0), after.get("servoMoves", 0)))
    mix = after.get("moveMix", {})
    h.check("staggerableGranted" in mix, "the governor accounted for the park starts",
            "granted=%s deferred=%s" % (mix.get("staggerableGranted"),
                                        mix.get("staggerableDeferred")))
    seen = h.observe("Did the servos move to rest PROGRESSIVELY (staggered), "
                     "not all at once?")
    if seen is not None:
        h.check(seen, "the arming park is governed, not a single in-rush")


def sc_oe(h):
    """/OE must be released only onto silent channels, and cut instantly on stop."""
    h.begin("oe", "/OE line (scope)")
    if not h.manual("Put a scope / logic analyser on the PCA9685 /OE line and on "
                    "one servo channel"):
        return
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    seen = h.observe("On arming: did /OE go LOW only AFTER the channels were "
                     "already silent (no burst of pulses at the moment /OE fell)?")
    if seen is not None:
        h.check(seen, "/OE is released onto neutralised outputs")
    h.dev.post("/api/panic")
    time.sleep(0.5)
    seen = h.observe("On panic: did /OE go HIGH immediately (< ~10 ms)?")
    if seen is not None:
        h.check(seen, "/OE cuts the outputs immediately on panic")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)


def sc_play(h):
    """Single notes, a chord, and fast Note On/Off."""
    h.begin("play", "Playing: single notes, chord, fast repeats")
    prof = h.dev.profile()
    strings = prof.get("strings", [])
    if not strings:
        h.skip("play", "no strings in the profile")
        return
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)

    before = h.dev.diagnostics()
    for s in strings:
        st, _, outcome = h.dev.command(
            "POST", "/api/test/note",
            {"channel": 0, "note": s.get("openNote", 60),
             "velocity": 100, "durationMs": 300})
        h.check(st == 202 and outcome == "succeeded",
                "open string %d plays" % s.get("openNote"),
                "HTTP %d, outcome=%s" % (st, outcome))
        time.sleep(0.45)
    after = h.dev.diagnostics()
    h.check(after.get("servoMoves", 0) > before.get("servoMoves", 0),
            "the open strings produced servo pulses")
    h.check(after.get("notesDroppedNoFinger", 0) ==
            before.get("notesDroppedNoFinger", 0),
            "no note was dropped for want of a finger")

    # A chord: every string at once. The firmware synchronises them on one strike
    # deadline, so they must SOUND together however staggered the preparation was.
    before = h.dev.diagnostics()
    for s in strings:
        h.dev.post("/api/test/note", {"channel": 0, "note": s.get("openNote", 60),
                                      "velocity": 100, "durationMs": 400})
    time.sleep(1.2)
    after = h.dev.diagnostics()
    h.check(after.get("midi", {}).get("droppedEvents", 0) ==
            before.get("midi", {}).get("droppedEvents", 0),
            "the chord dropped no MIDI event")
    seen = h.observe("Did the strings of the chord sound TOGETHER (one attack, "
                     "not a ripple)?")
    if seen is not None:
        h.check(seen, "chord notes are synchronised")

    # Fast Note On/Off: the stress case for the scheduler and the governor.
    before = h.dev.diagnostics()
    note = strings[0].get("openNote", 60)
    for _ in range(20):
        h.dev.post("/api/test/note", {"channel": 0, "note": note,
                                      "velocity": 100, "durationMs": 60})
        time.sleep(0.09)
    time.sleep(1.0)
    after = h.dev.diagnostics()
    h.check(after.get("midi", {}).get("droppedEvents", 0) ==
            before.get("midi", {}).get("droppedEvents", 0),
            "20 fast repeats dropped no event")
    h.check(after.get("faults", 0) == before.get("faults", 0),
            "20 fast repeats raised no fault")
    sched = after.get("scheduler", {})
    h.check(sched.get("maxLatencyUs", 0) < 50000,
            "loop() stayed responsive under load",
            "max latency %s us, jitter %s us" % (sched.get("maxLatencyUs"),
                                                 sched.get("jitterUs")))


def sc_loop_latency_vs_network(h):
    """The audit's P1: no network path may stall loop().

    The E-stop poll now runs before g_net.tick(), and the access-point bring-up
    is a timestamped FSM instead of a delay(100). The observable consequence is
    that loop()'s worst-case period stays small even while the radio is being
    reconfigured.
    """
    h.begin("loop_latency", "loop() latency while the network churns (audit P1)")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    base = h.dev.diagnostics().get("scheduler", {}).get("maxLatencyUs", 0)
    print("   baseline max loop latency: %s us" % base)

    # A Wi-Fi scan and a hotspot switch are the two heaviest radio operations the
    # UI can trigger; neither may block the safety poll.
    h.dev.get("/api/wifi/scan?start=1")
    time.sleep(6)
    scanned = h.dev.diagnostics().get("scheduler", {}).get("maxLatencyUs", 0)
    h.check(scanned < 50000, "a Wi-Fi scan does not stall loop()",
            "max latency %s us" % scanned)

    if h.manual("About to force the hotspot: the device WILL drop off this network. "
                "Reconnect your laptop to the device AP, then continue"):
        try:
            h.dev.post("/api/hotspot")
        except (urllib.error.URLError, OSError):
            pass  # the link goes down under us — expected
        input("   Reconnect to the device hotspot and press ENTER: ")
        try:
            after = h.dev.diagnostics().get("scheduler", {}).get("maxLatencyUs", 0)
            # Before the fix, startAccessPoint() sat on delay(100) = 100_000 us
            # inside a call made from loop().
            h.check(after < 50000,
                    "the access-point switch does not block loop() for 100 ms",
                    "max latency %s us (a delay(100) would show >= 100000)" % after)
        except (urllib.error.URLError, OSError) as e:
            h.skip("post-hotspot latency", "device unreachable: %s" % e)


def sc_estop(h):
    """The hardware E-stop, including while the network is busy."""
    h.begin("estop", "Hardware E-stop")
    prof = h.dev.profile()
    has_estop = any(p.get("signal") == "ESTOP" for p in prof.get("pins", []))
    if not has_estop:
        h.skip("estop", "no ESTOP pin declared in the profile")
        return
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)

    if h.manual("Press the E-stop (or open the NC loop)"):
        state = h.dev.wait_state({"emergencystop", "estop", "safe", "configsafe"},
                                 timeout=10)
        h.check(state not in ("ready", "readydegraded"),
                "the E-stop takes the device out of Ready", "state=%s" % state)
        seen = h.observe("Did every servo go limp immediately?")
        if seen is not None:
            h.check(seen, "the E-stop neutralises the servos")
        # Refusing to play while stopped is the whole point — and it has to be
        # PROVEN. /api/test/note answers 202 whatever the safety state (the
        # decision is taken later, on the loop), so the old `status != 200` check
        # passed on every single 202 without ever looking at the outcome.
        st, _, outcome = h.dev.command("POST", "/api/test/note",
                                       {"channel": 0, "note": 60, "velocity": 100,
                                        "durationMs": 200}, timeout=15)
        h.check(outcome in ("refused", "cancelled") or st in (409, 403),
                "the note is actually REFUSED while stopped",
                "HTTP %d, outcome=%s" % (st, outcome))

    # The audit's ordering fix: a stop must land even when the radio is busy.
    if h.manual("Release the E-stop, then press it again DURING heavy network "
                "traffic (start a Wi-Fi scan from the UI and press within a second)"):
        state = h.dev.wait_state({"emergencystop", "estop", "safe", "configsafe"},
                                 timeout=10)
        h.check(state not in ("ready", "readydegraded"),
                "the E-stop still lands while the network is busy",
                "state=%s" % state)

    if h.manual("Release the E-stop"):
        _, _, outcome = h.dev.command("POST", "/api/reset", timeout=60)
        state = h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
        h.check(outcome == "succeeded" and state in ("ready", "readydegraded"),
                "the device re-arms after the E-stop is released",
                "command=%s state=%s" % (outcome, state))


def sc_pca_loss(h):
    """A PCA9685 lost mid-play must be detected ON THE WRITE (audit P1)."""
    h.begin("pca_loss", "PCA9685 unplugged during play (audit P1)")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    prof = h.dev.profile()
    strings = prof.get("strings", [])
    if not strings:
        h.skip("pca_loss", "no strings in the profile")
        return
    note = strings[0].get("openNote", 60)

    if not h.manual("Unplug the I2C connector (SDA or SCL) of the PCA9685 — "
                    "the servo supply stays on"):
        return
    before = h.dev.diagnostics()
    # Ask for a note NOW: the write must fail and be reported, not be assumed Ok.
    h.dev.post("/api/test/note", {"channel": 0, "note": note,
                                  "velocity": 100, "durationMs": 300})
    time.sleep(1.0)
    after = h.dev.diagnostics()
    pca = after.get("pca", {})
    h.check(not pca.get("healthy", True), "the lost board is detected",
            "failedBoard=%s" % pca.get("failedBoard"))
    h.check(after.get("faults", 0) > before.get("faults", 0),
            "a fault is raised", "%d -> %d" % (before.get("faults", 0),
                                               after.get("faults", 0)))
    st = h.dev.status()
    h.check(str(st.get("state", "")).lower() in ("readydegraded", "safe",
                                                 "emergencystop", "configsafe"),
            "the instrument degrades instead of playing on",
            "state=%s" % st.get("state"))
    faults = st.get("faults", [])
    h.check(bool(faults), "the fault is described to the user",
            "; ".join(f.get("message", "") for f in faults[:2]))

    if h.manual("Plug the I2C connector back in and reboot the ESP32"):
        state = h.dev.wait_state({"ready", "readydegraded"}, timeout=90)
        h.check(state in ("ready", "readydegraded"), "the device recovers after reboot",
                "state=%s" % state)


def sc_i2c_wedge(h):
    """A wedged bus (SDA held low) must not hang the loop."""
    h.begin("i2c_wedge", "I2C bus held low")
    if not h.manual("Short SDA to GND (a wedged bus, worse than an unplug)"):
        return
    time.sleep(1.5)
    try:
        diag = h.dev.diagnostics()
    except (urllib.error.URLError, OSError) as e:
        h.check(False, "the web layer still answers with the bus wedged", str(e))
        return
    h.check(True, "the web layer still answers with the bus wedged")
    sched = diag.get("scheduler", {})
    h.check(sched.get("maxLatencyUs", 0) < 500000,
            "loop() is not hung by the wedged bus",
            "max latency %s us" % sched.get("maxLatencyUs"))
    h.check(not diag.get("pca", {}).get("healthy", True),
            "the wedged bus is reported unhealthy")
    h.manual("Remove the short and reboot the ESP32")
    h.dev.wait_state({"ready", "readydegraded"}, timeout=90)


def sc_servo_supply(h):
    """Dropping the servo rail must not take the controller with it."""
    h.begin("servo_supply", "Servo supply drop")
    if not h.manual("Cut the 5-6 V SERVO supply (leave the ESP32 powered)"):
        return
    time.sleep(1.0)
    try:
        diag = h.dev.diagnostics()
        h.check(True, "the ESP32 survives the servo-rail drop",
                "uptime %s ms, reset: %s" % (diag.get("uptimeMs"),
                                             diag.get("resetReason")))
        h.check("brown" not in str(diag.get("resetReason", "")).lower(),
                "no brown-out reset", "reset=%s" % diag.get("resetReason"))
    except (urllib.error.URLError, OSError) as e:
        h.check(False, "the ESP32 survives the servo-rail drop", str(e))
    h.manual("Restore the servo supply")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)


def sc_profile_swap(h):
    """Changing profile WHILE a note sounds must lift the old fingers first."""
    h.begin("profile_swap", "Profile change during a sounding note")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    prof = h.dev.profile()
    strings = prof.get("strings", [])
    if not strings:
        h.skip("profile_swap", "no strings in the profile")
        return

    # Sound a long note, then swap the profile out from under it.
    h.dev.post("/api/test/note", {"channel": 0, "note": strings[0].get("openNote", 60),
                                  "velocity": 100, "durationMs": 3000})
    time.sleep(0.3)
    edited = json.loads(json.dumps(prof))
    edited["instrument"]["name"] = (prof.get("instrument", {}).get("name", "gmb")
                                    + " (HIL)")
    status, _, outcome = h.dev.command("PUT", "/api/profile", edited, timeout=60)
    h.check(status == 202, "the swap is queued mid-note (202)", "HTTP %d" % status)
    h.check(outcome == "succeeded", "the swap completes", "outcome=%s" % outcome)
    state = h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    h.check(state in ("ready", "readydegraded"), "the new profile is armed",
            "state=%s" % state)
    seen = h.observe("Did the pressed finger LIFT before the swap, and no finger "
                     "stay stuck down afterwards?")
    if seen is not None:
        h.check(seen, "the two-phase swap lifts the old fingers")

    # Put the name back so the bench profile is left as we found it.
    restored = json.loads(json.dumps(prof))
    _, _, restore_outcome = h.dev.command("PUT", "/api/profile", restored, timeout=60)
    h.check(restore_outcome == "succeeded", "the bench profile is restored",
            "outcome=%s" % restore_outcome)


def sc_panic_http(h):
    """The software panic path, and re-arming after it."""
    h.begin("panic", "Software panic over HTTP")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    # /api/panic is NOT a queued command: it sets a flag the loop services, and
    # answers 200 immediately.
    status, _ = h.dev.post("/api/panic")
    h.check(status == 200, "POST /api/panic accepted", "HTTP %d" % status)
    time.sleep(0.6)
    st = h.dev.status()
    h.check(str(st.get("state", "")).lower() not in ("ready", "readydegraded"),
            "the device leaves Ready on panic", "state=%s" % st.get("state"))
    snote, _, outcome = h.dev.command("POST", "/api/test/note",
                                      {"channel": 0, "note": 60, "velocity": 100,
                                       "durationMs": 200}, timeout=15)
    h.check(outcome in ("refused", "cancelled") or snote in (409, 403),
            "the note is actually REFUSED after a panic",
            "HTTP %d, outcome=%s" % (snote, outcome))
    _, _, outcome = h.dev.command("POST", "/api/reset", timeout=60)
    state = h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    h.check(outcome == "succeeded" and state in ("ready", "readydegraded"),
            "re-arming after a panic works",
            "command=%s state=%s" % (outcome, state))


def sc_wifi_loss(h):
    """Losing Wi-Fi must cancel pending work but keep the instrument armed."""
    h.begin("wifi_loss", "Wi-Fi loss and recovery")
    h.dev.command("POST", "/api/reset", timeout=60)
    h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    before = h.dev.diagnostics()
    if not h.manual("Power the access point / router off for ~20 s, then back on"):
        return
    deadline = time.time() + 180
    diag = None
    while time.time() < deadline:
        try:
            diag = h.dev.diagnostics()
            break
        except (urllib.error.URLError, OSError):
            time.sleep(2)
    if diag is None:
        h.check(False, "the device comes back after the Wi-Fi outage",
                "still unreachable after 180 s")
        return
    h.check(True, "the device comes back after the Wi-Fi outage")
    h.check(diag.get("wifiReconnects", 0) > before.get("wifiReconnects", 0),
            "the reconnection is counted",
            "%s -> %s" % (before.get("wifiReconnects"), diag.get("wifiReconnects")))
    seen = h.observe("Did the servos stay parked (no movement) during the outage?")
    if seen is not None:
        h.check(seen, "a Wi-Fi outage causes no mechanical movement")
    state = h.dev.wait_state({"ready", "readydegraded"}, timeout=60)
    h.check(state in ("ready", "readydegraded"),
            "the instrument is playable again", "state=%s" % state)


def sc_reset(h):
    """A bare ESP32 reset must come back safe, then armed."""
    h.begin("reset", "ESP32 reset")
    if not h.manual("Press the ESP32 RESET/EN button"):
        return
    time.sleep(2)
    deadline = time.time() + 90
    diag = None
    while time.time() < deadline:
        try:
            diag = h.dev.diagnostics()
            break
        except (urllib.error.URLError, OSError):
            time.sleep(2)
    if diag is None:
        h.check(False, "the device comes back after a reset", "unreachable after 90 s")
        return
    h.check(True, "the device comes back after a reset",
            "reset reason: %s" % diag.get("resetReason"))
    seen = h.observe("At reset, did the servos stay still until the arming park "
                     "(no uncontrolled jump)?")
    if seen is not None:
        h.check(seen, "reset is mechanically safe")
    state = h.dev.wait_state({"ready", "readydegraded"}, timeout=90)
    h.check(state in ("ready", "readydegraded"), "the device re-arms on its own",
            "state=%s" % state)


SCENARIOS = [
    ("reachable", sc_reachable),
    ("boot_safe", sc_boot_safe),
    ("arming", sc_arming),
    ("oe", sc_oe),
    ("play", sc_play),
    ("loop_latency", sc_loop_latency_vs_network),
    ("estop", sc_estop),
    ("pca_loss", sc_pca_loss),
    ("i2c_wedge", sc_i2c_wedge),
    ("servo_supply", sc_servo_supply),
    ("profile_swap", sc_profile_swap),
    ("panic", sc_panic_http),
    ("wifi_loss", sc_wifi_loss),
    ("reset", sc_reset),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host",
                    help="device host or URL (gmb-ukulele.local, 192.168.1.42, …)")
    ap.add_argument("--token", help="admin token, if one is configured")
    ap.add_argument("--only", help="comma-separated scenario names to run")
    ap.add_argument("--skip", help="comma-separated scenario names to skip")
    ap.add_argument("--unattended", action="store_true",
                    help="skip every step needing a human (API-only subset)")
    ap.add_argument("--report", default="hil-report.json", help="JSON report path")
    ap.add_argument("--wait-scale", type=float, default=1.0,
                    help="scale every wait budget (CI self-check only; keep 1.0 "
                         "on hardware)")
    ap.add_argument("--list", action="store_true", help="list the scenarios and exit")
    args = ap.parse_args()

    if args.list:
        for name, fn in SCENARIOS:
            print("%-14s %s" % (name, (fn.__doc__ or "").strip().split("\n")[0]))
        return 0

    if not args.host:
        ap.error("--host is required (or use --list)")

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    skip = {s.strip() for s in args.skip.split(",")} if args.skip else set()

    dev = Device(args.host, args.token, wait_scale=args.wait_scale)
    h = Harness(dev, unattended=args.unattended)

    print("%sServo-Plucked-Strings-GMB — hardware-in-the-loop%s" % (BOLD, RESET))
    print("device: %s%s" % (dev.base, "  (unattended)" if args.unattended else ""))

    for name, fn in SCENARIOS:
        if only is not None and name not in only:
            continue
        if name in skip:
            continue
        try:
            if fn(h) is False:      # reachability failed: nothing else can run
                break
        except KeyboardInterrupt:
            print("\ninterrupted")
            break
        except Exception as e:      # a broken scenario must not hide the rest
            h.check(False, "scenario %s raised" % name, repr(e))

    passed = sum(1 for r in h.results if r["ok"] is True)
    print("\n%s%d passed, %d failed, %d skipped%s"
          % (BOLD, passed, h.failures, h.skipped, RESET))
    with open(args.report, "w") as f:
        json.dump({"device": dev.base, "results": h.results,
                   "passed": passed, "failed": h.failures, "skipped": h.skipped},
                  f, indent=2)
    print("report: %s" % args.report)
    return 1 if h.failures else 0


if __name__ == "__main__":
    sys.exit(main())
