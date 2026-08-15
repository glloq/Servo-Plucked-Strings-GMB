#!/usr/bin/env python3
"""Run the HIL harness against the mock device — in CI, with no hardware.

A test harness that has never been executed is not a test harness. The previous
version of run_hil.py shipped with three defects a syntax check could not see:
the wrong auth header, `status != 200` used to "prove" a note was refused (every
202 passes that), and a command timeout counted as a pass.

So this drives the REAL harness against mock_device.py and asserts both halves of
what a harness must do:

  * on a well-behaved device, every automated check PASSES;
  * on a misbehaving device, the harness FAILS — and fails on the right check.

Usage:  python3 selfcheck.py        (exit 0 = the harness is trustworthy)
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_HIL = os.path.join(HERE, "run_hil.py")
sys.path.insert(0, HERE)
import mock_device  # noqa: E402

PORT = [8399]  # bumped per case so a lingering socket cannot cross-talk

failures = 0


def report(ok, label, detail=""):
    global failures
    if not ok:
        failures += 1
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", label,
                         (" — " + detail) if detail else ""))


def run_harness(token=None, misbehave=None, only=None, harness_token=None):
    """Serve a mock, run run_hil.py against it, return (exit_code, report)."""
    PORT[0] += 1
    port = PORT[0]
    srv = mock_device.serve(port, token=token, misbehave=misbehave)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    time.sleep(0.2)
    try:
        with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as f:
            path = f.name
        # The bench budgets (30-90 s) are right for hardware and pointless here:
        # the mock answers instantly, and the one case that must time out should
        # cost a second, not a minute.
        cmd = [sys.executable, RUN_HIL, "--host", "127.0.0.1:%d" % port,
               "--unattended", "--wait-scale", "0.05", "--report", path]
        if harness_token:
            cmd += ["--token", harness_token]
        if only:
            cmd += ["--only", only]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        with open(path) as f:
            rep = json.load(f)
        os.unlink(path)
        return proc.returncode, rep, proc.stdout
    finally:
        srv.shutdown()
        srv.server_close()


def checks_named(rep, needle):
    return [r for r in rep["results"] if needle.lower() in r["check"].lower()]


# --------------------------------------------------------------------------- #

print("== the harness passes against a well-behaved device ==")
code, rep, out = run_harness()
report(code == 0, "exit code 0", "got %d" % code)
report(rep["failed"] == 0, "no failed check",
       "; ".join(r["check"] for r in rep["results"] if r["ok"] is False))
report(rep["passed"] > 15, "a meaningful number of checks actually ran",
       "%d passed" % rep["passed"])

print("\n== the auth header is the one the firmware reads ==")
# The mock demands X-GMB-Token. A harness sending the old X-Admin-Token gets 401
# on every write, so its checks collapse.
code, rep, out = run_harness(token="s3cret", harness_token="s3cret")
report(code == 0, "an authenticated run passes", "exit %d, %d failed"
       % (code, rep["failed"]))
# And the same run WITHOUT the token must not silently pass.
code, rep, out = run_harness(token="s3cret", harness_token=None,
                             only="reachable,arming")
report(code != 0, "an unauthenticated run FAILS instead of passing quietly",
       "exit %d" % code)

print("\n== a device that does not stop on panic is caught ==")
code, rep, out = run_harness(misbehave="never-stops", only="reachable,panic")
report(code != 0, "the run fails overall", "exit %d" % code)
stopped = checks_named(rep, "leaves Ready on panic")
refused = checks_named(rep, "REFUSED after a panic")
report(bool(stopped) and stopped[0]["ok"] is False,
       "the 'leaves Ready on panic' check catches it")
report(bool(refused) and refused[0]["ok"] is False,
       "the note-refusal check catches it — this is the one the old "
       "`status != 200` assertion passed blindly")

print("\n== a command that never resolves is a FAILURE, not a pass ==")
code, rep, out = run_harness(misbehave="slow-command", only="reachable,arming")
report(code != 0, "the run fails overall", "exit %d" % code)
armed = checks_named(rep, "arming command SUCCEEDED")
report(bool(armed) and armed[0]["ok"] is False,
       "a timeout is reported as a failure",
       armed[0]["detail"] if armed else "check missing")

print("\n== the 202 contract is understood ==")
code, rep, out = run_harness(only="reachable,play")
queued = checks_named(rep, "is queued (202)") + checks_named(rep, "plays")
report(bool(queued), "the harness asserts on queued-command outcomes, not on 200")
report(all(r["ok"] for r in queued), "and they pass against a correct device")

print("\n%d failure(s)" % failures)
sys.exit(1 if failures else 0)
