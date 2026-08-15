#!/usr/bin/env python3
"""A REST mock of the firmware's WebApi, so the HIL harness is testable in CI.

WHY
    The HIL harness can only be validated on a bench — but its *logic* can be
    validated anywhere, and it has to be: the previous version shipped with three
    defects that a syntax check could never catch. It sent the wrong auth header
    (`X-Admin-Token` instead of `X-GMB-Token`), it asserted `status != 200` to
    prove a note had been refused (every 202 passes that), and it treated a
    command timeout as a success.

    This mock reproduces the SEMANTICS of `platform/esp32/WebApi.cpp` — not its
    behaviour as an instrument, but its contract:

      * mechanical routes answer **202 Accepted** with a `commandId`, and the
        outcome is only readable later from `GET /api/commands?id=N`;
      * `/api/panic` answers **200** immediately (it sets a flag, it queues
        nothing);
      * writes require the **`X-GMB-Token`** header once a token is configured,
        and answer **401** without it;
      * a command issued while the device is stopped ends up **refused**, not
        rejected at the HTTP layer;
      * `/api/status` exposes `state`, `/api/diagnostics` the counters the
        harness reads.

    Run by `selfcheck.sh`, which drives the real harness against it and asserts
    that the harness both passes on a well-behaved device and FAILS on a
    misbehaving one.

USAGE
    python3 mock_device.py [--port 8123] [--token TOK] [--misbehave MODE]

    --misbehave keeps answering 200/202 while doing the wrong thing, so the
    harness's ability to catch it can be asserted:
      never-stops   : stays Ready and plays notes even after a panic
      slow-command  : accepts commands and never resolves them (timeout)
      wrong-token   : rejects the documented header, accepts the old one
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class DeviceModel:
    """The bit of instrument state the HIL harness can observe."""

    def __init__(self, token=None, misbehave=None):
        self.token = token
        self.misbehave = misbehave
        self.state = "ready"
        self.armed = True
        self.lock = threading.Lock()
        self.next_id = 1
        self.commands = {}       # id -> {"state": ..., "at": ...}
        self.servo_moves = 0
        self.faults = 0
        self.wifi_reconnects = 1
        self.midi_events = 0
        self.profile = {
            "instrument": {"name": "Ukulele HIL", "stringCount": 1},
            "board": {"profile": "esp32-s3-devkitc-1", "reserveUsb": True},
            "pins": [{"signal": "SDA", "gpio": 40}, {"signal": "SCL", "gpio": 41},
                     {"signal": "SERVO_OE", "gpio": 47}, {"signal": "ESTOP", "gpio": 2}],
            "power": {"maxConcurrentMoves": 3, "maxConcurrentPerBoard": 0,
                      "staggerMs": 8},
            "strings": [{"enabled": True, "openNote": 67, "maxFret": 3}],
            "servos": [
                {"function": "finger", "stringIndex": 0, "fret": 1,
                 "source": "pca", "pcaBoard": 0, "channel": 0},
                {"function": "pluck", "stringIndex": 0, "fret": -1,
                 "source": "pca", "pcaBoard": 0, "channel": 3},
            ],
        }

    # -- command queue ------------------------------------------------------ #

    def queue(self, kind):
        """Accept a command and decide its fate the way the loop would."""
        with self.lock:
            cid = self.next_id
            self.next_id += 1
            if self.misbehave == "slow-command":
                self.commands[cid] = {"state": "queued", "at": None}
                return cid
            # A command that needs the actuators is REFUSED while stopped — at
            # the command layer, exactly like the firmware, never at HTTP.
            if kind in ("note", "servo") and not self.armed:
                outcome = "refused"
            else:
                outcome = "succeeded"
                if kind == "note":
                    self.servo_moves += 3
                    self.midi_events += 2
                elif kind == "reset":
                    self.servo_moves += 8
                    self.armed = True
                    self.state = "ready"
                elif kind == "profile":
                    self.servo_moves += 8
                    self.state = "ready"
            # Resolved a beat later, so the harness really has to poll.
            self.commands[cid] = {"state": "queued",
                                  "at": time.time() + 0.15, "outcome": outcome}
            return cid

    def command_state(self, cid):
        with self.lock:
            c = self.commands.get(cid)
            if not c:
                return "unknown"
            if c["at"] is None:
                return "queued"          # slow-command: never resolves
            if time.time() >= c["at"]:
                c["state"] = c["outcome"]
            return c["state"]

    def panic(self):
        with self.lock:
            if self.misbehave == "never-stops":
                return               # keeps playing: the harness must catch it
            self.armed = False
            self.state = "emergencyStop"
            self.faults += 1


class Handler(BaseHTTPRequestHandler):
    model = None

    def log_message(self, *a):
        pass

    # -- helpers ------------------------------------------------------------ #

    def _send(self, obj, code=200):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _auth_ok(self):
        m = self.model
        if not m.token:
            return True             # no token configured: writes are open
        if m.misbehave == "wrong-token":
            return self.headers.get("X-Admin-Token") == m.token
        return self.headers.get("X-GMB-Token") == m.token

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _queued(self, kind):
        """The 202 + commandId contract shared by every mechanical route."""
        if not self._auth_ok():
            self._send({"ok": False, "error": "unauthorized"}, 401)
            return
        cid = self.model.queue(kind)
        self._send({"ok": True, "accepted": True, "commandId": cid,
                    "note": "%s queued" % kind}, 202)

    # -- routes ------------------------------------------------------------- #

    def do_GET(self):
        m = self.model
        path = self.path.split("?")[0]
        if path == "/api/status":
            self._send({"state": m.state, "safety": "armed" if m.armed else "safe",
                        "activeProfile": m.profile["instrument"]["name"],
                        "stringsTotal": len(m.profile["strings"]),
                        "stringsReady": len(m.profile["strings"]) if m.armed else 0,
                        "notesPlaying": 0, "authConfigured": bool(m.token),
                        "faults": ([{"source": "estop", "message": "emergency stop"}]
                                   if not m.armed else [])})
        elif path == "/api/diagnostics":
            self._send({"uptimeMs": int(time.time() * 1000) % 10 ** 7,
                        "resetReason": "power-on", "freeHeap": 180000,
                        "minFreeHeap": 150000, "state": m.state,
                        "midi": {"events": m.midi_events, "droppedEvents": 0,
                                 "droppedPackets": 0},
                        "scheduler": {"maxLatencyUs": 900, "jitterUs": 120,
                                      "meanUs": 400},
                        "cmdQueueHighWater": 2, "faults": m.faults,
                        "servoMoves": m.servo_moves, "governorThrottles": 1,
                        "notesDroppedNoFinger": 0,
                        "moveMix": {"deadline": 2, "staggerableGranted": 7,
                                    "staggerableDeferred": 1},
                        "wifiReconnects": m.wifi_reconnects,
                        "pca": {"used": True, "healthy": True}})
        elif path == "/api/profile":
            self._send(m.profile)
        elif path == "/api/commands":
            try:
                cid = int(self.path.split("id=")[1])
            except (IndexError, ValueError):
                self._send({"error": "bad id"}, 400)
                return
            self._send({"id": cid, "state": m.command_state(cid)})
        elif path == "/api/wifi/scan":
            self._send({"scanning": False, "networks": []})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        self._body()
        path = self.path.split("?")[0]
        if path == "/api/reset":
            self._queued("reset")
        elif path == "/api/test/note":
            self._queued("note")
        elif path == "/api/test/servo":
            if not self.model.armed:
                # This route DOES refuse upfront (409), unlike /api/test/note.
                self._send({"ok": False, "error": "actuators not armed"}, 409)
            else:
                self._queued("servo")
        elif path == "/api/panic":
            if not self._auth_ok():
                self._send({"ok": False, "error": "unauthorized"}, 401)
                return
            self.model.panic()
            self._send({"ok": True})           # 200, NOT a queued command
        elif path == "/api/hotspot":
            if not self._auth_ok():
                self._send({"ok": False, "error": "unauthorized"}, 401)
                return
            self._send({"ok": True, "note": "switching to access point"}, 202)
        else:
            self._send({"error": "not found"}, 404)

    def do_PUT(self):
        body = self._body()
        if self.path.split("?")[0] == "/api/profile":
            if not self._auth_ok():
                self._send({"ok": False, "error": "unauthorized"}, 401)
                return
            if body:
                self.model.profile = body
            cid = self.model.queue("profile")
            self._send({"ok": True, "accepted": True, "commandId": cid,
                        "capabilitiesRevision": 8}, 202)
        else:
            self._send({"error": "not found"}, 404)


def serve(port, token=None, misbehave=None):
    Handler.model = DeviceModel(token, misbehave)
    srv = HTTPServer(("127.0.0.1", port), Handler)
    return srv


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--token")
    ap.add_argument("--misbehave",
                    choices=["never-stops", "slow-command", "wrong-token"])
    ap.add_argument("--seconds", type=float, default=0,
                    help="serve for this long then exit (0 = forever)")
    args = ap.parse_args()
    srv = serve(args.port, args.token, args.misbehave)
    if args.seconds:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        time.sleep(args.seconds)
    else:
        srv.serve_forever()


if __name__ == "__main__":
    main()
