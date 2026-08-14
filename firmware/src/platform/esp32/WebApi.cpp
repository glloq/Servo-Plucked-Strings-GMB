#include "WebApi.h"

#include "ProfileStorage.h"
#include "WebAssets.h"
#include "../../core/configuration/ProfileValidator.h"

#if defined(ARDUINO)
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <LittleFS.h>
#endif

namespace gmb {

#if defined(ARDUINO)

namespace {

const char* prefName(PinPreference p) {
    switch (p) {
        case PinPreference::Recommended: return "recommended";
        case PinPreference::Caution: return "caution";
        case PinPreference::Reserved: return "reserved";
        default: return "used";
    }
}

void sendJson(AsyncWebServerRequest* req, JsonDocument& doc, int code = 200) {
    String out;
    serializeJson(doc, out);
    req->send(code, "application/json", out);
}

// JSON bodies that carry a FULL profile (servo-per-fret: dozens of servos with
// ~30 fields each) serialize to 26–45 KB for the shipped instruments — far over
// AsyncCallbackJsonWebHandler's 16 KB default, which made every profile save /
// activate / validate fail with HTTP 413. 128 KB gives ~3x headroom over the
// largest shipped profile while still bounding a hostile body (the parse
// allocates from the heap). Only the profile-carrying routes get this limit;
// small-body routes keep the default.
constexpr int kMaxProfileJsonBytes = 128 * 1024;

// RAII guard for the shared-state lock supplied by the main loop. Held only while
// a read-only handler samples g_profile / instrument / servos / sysex so a
// reload in loop() is never observed half-applied.
struct WebStateLock {
    const WebContext& ctx;
    explicit WebStateLock(const WebContext& c) : ctx(c) { if (ctx.lockState) ctx.lockState(); }
    ~WebStateLock() { if (ctx.unlockState) ctx.unlockState(); }
};

// RAII guard for the LittleFS lock (distinct from the state lock: loop() never
// waits on it, so a flash write here can't stall the safety loop).
struct WebStorageLock {
    const WebContext& ctx;
    explicit WebStorageLock(const WebContext& c) : ctx(c) { if (ctx.lockStorage) ctx.lockStorage(); }
    ~WebStorageLock() { if (ctx.unlockStorage) ctx.unlockStorage(); }
};

const char* stringStateName(StringState s) {
    switch (s) {
        case StringState::Disabled:        return "disabled";
        case StringState::Idle:            return "idle";
        case StringState::ReleasingFinger: return "releasing";
        case StringState::Moving:          return "moving";
        case StringState::PressingFinger:  return "pressing";
        case StringState::Settling:        return "settling";
        case StringState::ReadyToPluck:    return "ready";
        case StringState::Plucking:        return "plucking";
        case StringState::Sustaining:      return "sustaining";
        case StringState::Damping:         return "damping";
        case StringState::Cancelling:      return "cancelling";
        case StringState::Fault:           return "fault";
        default:                           return "idle";
    }
}

// Whether the finger is pressed for this state (open strings never press).
bool fingerDown(StringState s, bool openString) {
    if (openString) return false;
    switch (s) {
        case StringState::PressingFinger:
        case StringState::Settling:
        case StringState::ReadyToPluck:
        case StringState::Plucking:
        case StringState::Sustaining:
            return true;
        default:
            return false;
    }
}

const char* safetyStateName(SafetyState s) {
    switch (s) {
        case SafetyState::ConfigSafe:    return "configSafe";
        case SafetyState::PowerOnSafe:   return "powerOnSafe";
        case SafetyState::Parking:       return "parking";
        case SafetyState::Armed:         return "armed";
        case SafetyState::Panic:         return "panic";
        case SafetyState::EmergencyStop: return "emergencyStop";
        default:                         return "safe";
    }
}

const char* midiTypeName(uint8_t type) {
    switch (type) {
        case 0x80: return "noteOff";
        case 0x90: return "noteOn";
        case 0xA0: return "polyAftertouch";
        case 0xB0: return "controlChange";
        case 0xC0: return "programChange";
        case 0xD0: return "channelAftertouch";
        case 0xE0: return "pitchBend";
        default: return "other";
    }
}

// Built-in page served on "/" when the LittleFS web UI is missing (/www never
// uploaded, or the filesystem failed to mount). Without it the captive portal
// redirected EVERY not-found URL — including "/" itself — to the portal root,
// i.e. "/" redirected to "/" forever: the browser's ERR_TOO_MANY_REDIRECTS.
const char kMissingUiPage[] PROGMEM =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Servo-Plucked-Strings-GMB</title>"
    "<style>body{font-family:sans-serif;max-width:38em;margin:2em auto;"
    "padding:0 1em;line-height:1.5}code{background:#eee;padding:0 .3em;"
    "border-radius:3px}</style></head><body>"
    "<h1>Servo-Plucked-Strings-GMB</h1>"
    "<p><strong>The firmware is running</strong>, but the web interface files "
    "were not found on the device (LittleFS <code>/www</code> is empty or the "
    "filesystem did not mount).</p>"
    "<p>Upload the web UI, then reload this page:</p><ol>"
    "<li>In <code>firmware/</code>, run <code>./sync_web_data.sh</code> "
    "(copies <code>web-interface/</code> to <code>firmware/data/www</code>).</li>"
    "<li>Upload the filesystem: PlatformIO <code>pio run -t uploadfs</code>, or "
    "the Arduino IDE LittleFS upload plugin &mdash; see "
    "<code>docs/ARDUINO_IDE_BUILD.md</code> &sect;7.</li></ol>"
    "<p>The REST API is live: <a href=\"/api/status\">/api/status</a> &middot; "
    "<a href=\"/api/diagnostics\">/api/diagnostics</a></p></body></html>";

}  // namespace

// Single status DTO shared by GET /api/status and the /ws/status broadcast so
// the two never diverge (fixes the frontend/backend status mismatch).
void WebApi::fillStatus(JsonDocument& doc) {
    doc["state"] = ctx_.appState ? ctx_.appState() : "boot";
    JsonObject wifi = doc["wifi"].to<JsonObject>();
    wifi["mode"] = ctx_.net ? ctx_.net->mode() : "unknown";
    wifi["ssid"] = ctx_.profile ? ctx_.profile->network.ssid : "";
    wifi["ip"] = ctx_.net ? ctx_.net->ipAddress() : "";
    wifi["connected"] = ctx_.net ? ctx_.net->connected() : false;
    doc["midiSource"] = "wifiUdp";
    // UDP source posture (audit 4 P2.3) so the Settings UI shows the live state.
    doc["midiSourcePolicy"] =
        ctx_.midiSourcePolicy ? ctx_.midiSourcePolicy() : "open";
    doc["midiSourceLocked"] =
        ctx_.midiSourceLocked ? ctx_.midiSourceLocked() : false;
    doc["activeProfile"] = ctx_.profile ? ctx_.profile->instrument.name : "";
    doc["capabilitiesRevision"] =
        ctx_.sysex ? ctx_.sysex->snapshot().revision : 0;
    int total = ctx_.instrument ? static_cast<int>(ctx_.instrument->stringCount()) : 0;
    bool armed = ctx_.safety && ctx_.safety->actuatorsAllowed();
    doc["stringsTotal"] = total;
    // Actually-ready, non-faulted strings (not just "armed => all") so a degraded
    // run reports the true count.
    doc["stringsReady"] = ctx_.readyStrings ? ctx_.readyStrings() : (armed ? total : 0);
    doc["notesPlaying"] = ctx_.instrument ? ctx_.instrument->soundingCount() : 0;
    // Full safety state (powerOnSafe / armed / panic / emergencyStop), not just
    // armed/safe, so the UI can tell a latched panic or E-stop from plain boot.
    doc["safety"] = ctx_.safety ? safetyStateName(ctx_.safety->state())
                                : (armed ? "armed" : "safe");
    doc["authConfigured"] = ctx_.authConfigured ? ctx_.authConfigured() : false;
    // The AP is "open" when it is active and NOT WPA2-secured (real password
    // check, not merely whether the auth callback exists).
    doc["apOpen"] = ctx_.net && ctx_.net->accessPointActive() &&
                    !ctx_.net->accessPointSecured();
    JsonArray faults = doc["faults"].to<JsonArray>();
    if (ctx_.safety)
        for (const auto& f : ctx_.safety->faults()) {
            JsonObject o = faults.add<JsonObject>();
            o["source"] = f.source;
            o["message"] = f.message;
            o["atMs"] = f.atMs;
        }
    JsonArray strings = doc["strings"].to<JsonArray>();
    if (ctx_.instrument) {
        int8_t capo = ctx_.profile ? ctx_.profile->instrument.capo : 0;
        // Both transposes, matching the selector/allocator (audit P1-15).
        int transpose = ctx_.profile ? (ctx_.profile->instrument.transpose +
                                        ctx_.profile->midi.transpose) : 0;
        for (size_t i = 0; i < ctx_.instrument->stringCount(); ++i) {
            const StringController& sc = ctx_.instrument->string(i);
            const StringTarget& tgt = ctx_.instrument->target(i);
            StringState st = sc.state();
            bool open = sc.openString();
            uint8_t openNote =
                (ctx_.profile && i < ctx_.profile->strings.size())
                    ? ctx_.profile->strings[i].openNote : 0;
            JsonObject s = strings.add<JsonObject>();
            s["index"] = i;
            s["openNote"] = openNote;
            s["state"] = stringStateName(st);
            s["fret"] = tgt.fret;
            s["active"] = tgt.active;
            // MIDI note currently sounding (best-effort from open note + fret).
            if (tgt.active)
                s["note"] = static_cast<int>(openNote) + tgt.fret + capo + transpose;
            else
                s["note"] = nullptr;
            // Servo-per-fret: no carriage position — just which finger (if any) is
            // pressed and whether the plucker is striking. The strike signal comes
            // from the SERVO BANK (engaged until the automatic return), not the
            // string FSM whose Plucking state lasts a single tick and was
            // practically invisible to the UI (audit 4 P3).
            s["finger"] = fingerDown(st, open) ? "down" : "up";
            bool striking = st == StringState::Plucking;
            if (ctx_.servos) {
                int pi = ctx_.servos->pluckIndex(static_cast<int>(i));
                if (pi < 0) pi = ctx_.servos->strumIndex(static_cast<int>(i));
                if (pi >= 0 && ctx_.servos->striking(pi)) striking = true;
            }
            s["plectrum"] = striking ? "strike" : "rest";
            s["lastFault"] = (st == StringState::Fault) ? "fault" : "none";
        }
    }
}

void WebApi::begin(const WebContext& ctx, uint16_t port) {
    ctx_ = ctx;
    if (server_ == nullptr) server_ = new AsyncWebServer(port);
    registerRoutes();

    statusWs_.onEvent([](AsyncWebSocket*, AsyncWebSocketClient*, AwsEventType,
                         void*, uint8_t*, size_t) {});
    midiWs_.onEvent([](AsyncWebSocket*, AsyncWebSocketClient*, AwsEventType, void*,
                       uint8_t*, size_t) {});
    server_->addHandler(&statusWs_);
    server_->addHandler(&midiWs_);

    // ---- Captive portal ---------------------------------------------------
    // The OS "is there internet?" probes must be answered with a REDIRECT (not the
    // 204/success they expect) so the phone/laptop pops its "sign in" sheet and
    // opens our page. Registered before the static handler so they take precedence.
    // Gated on AP mode (like onNotFound below): in station mode the device is a
    // normal host and must not hijack these paths to an unreachable AP address.
    auto redirectToPortal = [this](AsyncWebServerRequest* req) {
        if (ctx_.net && ctx_.net->accessPointActive())
            req->redirect(captivePortalUrl().c_str());
        else
            req->send(404, "text/plain", "Not found");
    };
    for (const char* probe : {"/generate_204", "/gen_204", "/hotspot-detect.html",
                              "/library/test/success.html", "/connecttest.txt",
                              "/ncsi.txt", "/redirect", "/canonical.html"}) {
        server_->on(probe, HTTP_GET, redirectToPortal);
    }

    // Static UI from LittleFS: an OPTIONAL per-file override of the embedded UI
    // below (update the interface on a device without recompiling). Registered
    // first, so an uploaded /www file always wins over its embedded copy.
    server_->serveStatic("/", LittleFS, "/www/").setDefaultFile("index.html");
    if (!LittleFS.exists("/www/index.html"))
        Serial.println("[web] LittleFS /www absent — serving the embedded web UI");

    // Anything else: embedded UI first, then in AP mode send it to the portal
    // (catches OS probes we did not name explicitly); otherwise a normal 404.
    server_->onNotFound([this](AsyncWebServerRequest* req) {
        // Web UI embedded in the firmware image (WebAssets.cpp, generated from
        // web-interface/): a plain firmware upload serves the whole interface
        // with no LittleFS-upload step. Only consulted on a LittleFS miss.
        std::string path(req->url().c_str());
        if (path == "/") path = "/index.html";
        if (const WebAsset* a = findWebAsset(path.c_str())) {
            AsyncWebServerResponse* res =
                req->beginResponse(200, a->mime, a->data, a->size);
            if (a->gzip) res->addHeader("Content-Encoding", "gzip");
            req->send(res);
            return;
        }
        // Last-resort setup page on "/" (firmware built with an empty asset
        // table AND no LittleFS UI). Never redirect "/" to itself — that loop
        // is the browser's "too many redirects" error.
        if (req->url() == "/" || req->url() == "/index.html") {
            req->send(200, "text/html", kMissingUiPage);
            return;
        }
        if (ctx_.net && ctx_.net->accessPointActive()) {
            req->redirect(captivePortalUrl().c_str());
        } else {
            req->send(404, "text/plain", "Not found");
        }
    });
    server_->begin();
}

std::string WebApi::captivePortalUrl() const {
    // The ESP32 softAP always answers on 192.168.4.1 (no softAPConfig is set), so
    // use the constant instead of reading Net's ip_ std::string from the async web
    // task — that field is written by the main loop and a cross-task read could tear
    // during an AP/station switch. (If you ever add softAPConfig, update this + the
    // NETWORK_HOTSPOT.md note.)
    return "http://192.168.4.1/";
}

bool WebApi::authOk(AsyncWebServerRequest* req) {
    if (!ctx_.checkToken) return true;
    std::string tok = std::string(req->header("X-GMB-Token").c_str());
    return ctx_.checkToken(tok);
}

void WebApi::registerRoutes() {
    // ---- GET /api/status ----
    server_->on("/api/status", HTTP_GET, [this](AsyncWebServerRequest* req) {
        // Serve the immutable snapshot produced by loop(); never read live state
        // from the async web task.
        std::string s;
        { WebStateLock lk(ctx_); s = cachedStatus_; }
        req->send(200, "application/json", String(s.c_str()));
    });

    // ---- GET /api/diagnostics (runtime telemetry for the bench, P2.19) ----
    // The body is built by loop() via the callback (reads accumulated counters +
    // cached PCA health), so the async web task never touches live I2C or state.
    server_->on("/api/diagnostics", HTTP_GET, [this](AsyncWebServerRequest* req) {
        std::string s = ctx_.diagnosticsJson ? ctx_.diagnosticsJson() : "{}";
        req->send(200, "application/json", String(s.c_str()));
    });

    // ---- GET /api/commands?id=N (result of a 202-accepted command) ----
    server_->on("/api/commands", HTTP_GET, [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        uint32_t id = 0;
        if (req->hasParam("id")) id = req->getParam("id")->value().toInt();
        doc["id"] = id;
        // queued / running / succeeded / refused / cancelled / failed / unknown
        // (unknown = never issued or aged out of the small result ring). An
        // activation is "running" until the new profile REALLY reaches ready
        // (audit 7); "succeeded" means done, never merely started.
        doc["state"] = ctx_.commandState ? ctx_.commandState(id) : "unknown";
        sendJson(req, doc);
    });

    // ---- POST /api/reset (recover from panic / E-stop, then re-arm) ----
    server_->on("/api/reset", HTTP_POST, [this](AsyncWebServerRequest* req) {
        if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized";
                            sendJson(req, d, 401); return; }
        uint32_t cmdId = ctx_.onReset ? ctx_.onReset() : 0;
        bool queued = cmdId != 0;
        JsonDocument doc;
        doc["ok"] = queued;
        doc["accepted"] = queued;
        doc["commandId"] = cmdId;  // poll GET /api/commands?id=... for the outcome
        doc["note"] = queued ? "reset queued" : "command queue full";
        sendJson(req, doc, queued ? 202 : 503);
    });

    // ---- GET /api/board/{id} ---- one route per built-in board profile. The
    // JSON carries exposed / input / output so the web can filter candidates
    // correctly (classic-ESP32 input-only pins 34/35/36/39 have output=false).
    auto emitBoard = [](AsyncWebServerRequest* req, const char* id) {
        const BoardProfile* b = builtinBoardProfile(id);
        if (!b) b = builtinBoardProfile("esp32-s3-devkitc-1");
        JsonDocument doc;
        doc["identifier"] = b->identifier;
        doc["displayName"] = b->displayName;
        JsonArray pins = doc["pins"].to<JsonArray>();
        for (const auto& p : b->pins) {
            JsonObject o = pins.add<JsonObject>();
            o["gpio"] = p.gpio;
            o["exposed"] = p.exposed;
            o["input"] = p.input;
            o["output"] = p.output;
            o["interrupt"] = p.interrupt;          // the ESTOP safety input needs it
            o["internalPullUp"] = p.internalPullUp;  // ESTOP is read as INPUT_PULLUP
            o["preference"] = prefName(p.preference);
            o["reserved"] = p.reserved;
            o["usb"] = p.usb;
            o["strapping"] = p.strapping;
            o["highSpeedOutput"] = p.highSpeedOutput;
            o["adc"] = p.adc;
            o["note"] = p.note;
        }
        sendJson(req, doc);
    };
    static const char* const kBoardIds[] = {
        "esp32-s3-devkitc-1", "esp32-s3-devkitc-1-v1.1", "esp32-wroom-32",
        "esp32-devkit-v1"};
    for (const char* id : kBoardIds) {
        server_->on((std::string("/api/board/") + id).c_str(), HTTP_GET,
                   [emitBoard, id](AsyncWebServerRequest* req) { emitBoard(req, id); });
    }

    // ---- POST /api/pins/auto (auto-assign GPIO for the wizard's draft) ----
    // Reads the wizard's request body so the assignment matches the DRAFT being
    // edited (string count, USB reservation, PCA /OE, ESTOP pin), not the
    // currently-active profile.
    auto* pinsAuto = new AsyncCallbackJsonWebHandler(
        "/api/pins/auto", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            // Assign against the board the DRAFT targets (body), else the active
            // profile's board, else the reference S3.
            std::string boardId = body["board"] | "";
            if (boardId.empty())
                boardId = ctx_.profile ? ctx_.profile->boardIdentifier
                                       : std::string("esp32-s3-devkitc-1");
            const BoardProfile* b = builtinBoardProfile(boardId);
            if (!b) b = builtinBoardProfile("esp32-s3-devkitc-1");
            PinManager pm(*b);
            PinRequest r;
            int fallback = ctx_.profile ? ctx_.profile->instrument.stringCount : 4;
            r.stringCount = body["stringCount"] | fallback;
            r.useI2cServos = body["useI2cServos"] | body["usePca"] | true;
            r.servoSafetyOe = body["servoSafetyOe"] | body["useOe"] | true;
            r.reserveUsb = body["reserveUsb"] | true;
            bool ok = pm.autoAssign(r);
            JsonDocument doc;
            doc["ok"] = ok;
            JsonArray pins = doc["pins"].to<JsonArray>();
            for (const auto& a : pm.assignments()) {
                JsonObject o = pins.add<JsonObject>();
                o["signal"] = a.signal;
                o["gpio"] = a.gpio;
            }
            sendJson(req, doc, ok ? 200 : 422);
        });
    pinsAuto->setMethod(HTTP_POST);
    server_->addHandler(pinsAuto);

    // ---- POST /api/panic ----
    server_->on("/api/panic", HTTP_POST, [this](AsyncWebServerRequest* req) {
        if (ctx_.onPanic) ctx_.onPanic();
        JsonDocument doc;
        doc["ok"] = true;
        sendJson(req, doc);
    });

    // ---- GET /api/capabilities ----
    server_->on("/api/capabilities", HTTP_GET, [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        WebStateLock lk(ctx_);  // snapshot may be rebuilt by loop() on a fault
        if (ctx_.sysex) {
            const CapabilitySnapshot& s = ctx_.sysex->snapshot();
            doc["revision"] = s.revision;
            doc["valid"] = s.valid;  // false => no playable string (degraded to nil)
            doc["noteMin"] = s.capabilities.noteMin;
            doc["noteMax"] = s.capabilities.noteMax;
            doc["polyphony"] = s.capabilities.polyphony;
            doc["ccString"] = s.stringConfig.ccString;
            doc["ccFret"] = s.stringConfig.ccFret;
            JsonArray cc = doc["cc"].to<JsonArray>();
            for (uint8_t c : s.capabilities.supportedCc) cc.add(c);
            JsonArray tuning = doc["tuning"].to<JsonArray>();
            for (uint8_t t : s.stringConfig.tuning) tuning.add(t);
        }
        sendJson(req, doc);
    });

    // ---- GET /gmb/descriptor.json (GMB v2 level-1 descriptor over HTTP) ----
    // Advertised by the SysEx handshake `flags` bit 0 so a GMB controller can fetch
    // the whole descriptor in one request instead of the segmented block 0x10
    // transfer. Served from the same immutable snapshot as the SysEx path.
    server_->on("/gmb/descriptor.json", HTTP_GET, [this](AsyncWebServerRequest* req) {
        std::string json;
        { WebStateLock lk(ctx_); if (ctx_.sysex) json = ctx_.sysex->descriptorJson(); }
        req->send(200, "application/json", String(json.c_str()));
    });

    // ---- GET /api/profile ----
    server_->on("/api/profile", HTTP_GET, [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        { WebStateLock lk(ctx_);  // g_profile may be swapped by loop() on activate
          if (ctx_.profile) ProfileStorage::toJson(*ctx_.profile, doc); }
        sendJson(req, doc);
    });

    // ---- GET /api/profiles (slot list) ----
    server_->on("/api/profiles", HTTP_GET, [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        JsonArray arr = doc["profiles"].to<JsonArray>();
        if (ctx_.storage) {
            WebStorageLock sl(ctx_);  // don't cross a concurrent save/delete (P1-2)
            auto names = ctx_.storage->list();
            for (size_t i = 0; i < names.size(); ++i) {
                JsonObject o = arr.add<JsonObject>();
                o["slot"] = i;
                o["name"] = names[i];
                o["used"] = !names[i].empty();
            }
            doc["startupSlot"] = ctx_.storage->startupSlot();
        }
        sendJson(req, doc);
    });

    // Body-parsing endpoints.
    auto validate = [this](const JsonVariant& body, JsonDocument& out) {
        Profile p;
        if (!ProfileStorage::fromJson(body, p)) {
            out["ok"] = false;
            out["error"] = "invalid profile JSON";
            return;
        }
        auto issues = ProfileValidator::validate(p);
        JsonArray errs = out["issues"].to<JsonArray>();
        bool ok = true;
        for (const auto& is : issues) {
            JsonObject o = errs.add<JsonObject>();
            o["field"] = is.field;
            o["message"] = is.message;
            o["severity"] =
                is.severity == ValidationIssue::Severity::Error ? "error" : "warning";
            if (is.severity == ValidationIssue::Severity::Error) ok = false;
        }
        out["ok"] = ok;
    };

    // ---- PUT /api/profile (validate + activate) ----
    auto* putProfile = new AsyncCallbackJsonWebHandler(
        "/api/profile", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            Profile p;
            JsonDocument doc;
            if (!ProfileStorage::fromJson(body, p)) {
                doc["ok"] = false;
                doc["error"] = "invalid profile JSON";
                sendJson(req, doc, 400);
                return;
            }
            auto issues = ProfileValidator::validate(p);
            bool ok = true;
            JsonArray errs = doc["issues"].to<JsonArray>();
            for (const auto& is : issues) {
                if (is.severity == ValidationIssue::Severity::Error) ok = false;
                JsonObject o = errs.add<JsonObject>();
                o["field"] = is.field;
                o["message"] = is.message;
                o["severity"] =
                    is.severity == ValidationIssue::Severity::Error ? "error" : "warning";
            }
            if (!ok) {
                doc["ok"] = false;
                sendJson(req, doc, 422);  // real error, not masked as success
                return;
            }
            // Validated above; the actual activation runs in loop() (servos
            // neutralised, reconfigure, re-arm). Report ACCEPTED, not "done".
            uint32_t cmdId = ctx_.onActivateProfile ? ctx_.onActivateProfile(p) : 0;
            bool queued = cmdId != 0;
            doc["ok"] = queued;
            doc["accepted"] = queued;
            doc["commandId"] = cmdId;
            doc["note"] = queued ? "activation queued" : "command queue full";
            sendJson(req, doc, queued ? 202 : 503);
        });
    putProfile->setMethod(HTTP_PUT);
    putProfile->setMaxContentLength(kMaxProfileJsonBytes);  // full profile body
    server_->addHandler(putProfile);

    // ---- POST /api/pins/validate (full-profile validation) ----
    auto* validatePins = new AsyncCallbackJsonWebHandler(
        "/api/pins/validate",
        [this, validate](AsyncWebServerRequest* req, JsonVariant& body) {
            JsonDocument doc;
            validate(body, doc);
            sendJson(req, doc, doc["ok"] == true ? 200 : 422);
        });
    validatePins->setMethod(HTTP_POST);
    validatePins->setMaxContentLength(kMaxProfileJsonBytes);  // full profile body
    server_->addHandler(validatePins);

    // ---- POST /api/profiles (save to a slot) ----
    auto* saveProfile = new AsyncCallbackJsonWebHandler(
        "/api/profiles", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            int slot = body["slot"] | -1;
            Profile p;
            // Copy the live profile (when no body profile) under the STATE lock —
            // brief, in-memory. The actual flash write below is under the STORAGE
            // lock so loop() never waits on it.
            bool parsed;
            { WebStateLock lk(ctx_);
              parsed = body["profile"].is<JsonObject>()
                           ? ProfileStorage::fromJson(body["profile"], p)
                           : (ctx_.profile ? (p = *ctx_.profile, true) : false); }
            if (slot < 0 || !parsed || !ctx_.storage) {
                doc["ok"] = false;
                doc["error"] = "slot and profile required";
                sendJson(req, doc, 400);
                return;
            }
            bool saved;
            bool startupOk = true;  // only meaningful when startup was requested
            { WebStorageLock sl(ctx_);  // serialise LittleFS; loop() never waits here
              saved = ctx_.storage->save(slot, p);
              if (saved && (body["startup"] | false))
                  startupOk = ctx_.storage->setStartupSlot(slot); }
            // A failed startup-slot write must not masquerade as success: the
            // profile is stored, but the OLD startup profile would still boot
            // (audit 4 P2.5).
            doc["ok"] = saved && startupOk;
            if (saved && !startupOk)
                doc["error"] = "profile saved but the startup-slot write failed";
            sendJson(req, doc, !saved ? 500 : (startupOk ? 200 : 500));
        });
    saveProfile->setMethod(HTTP_POST);
    saveProfile->setMaxContentLength(kMaxProfileJsonBytes);  // body may embed a profile
    server_->addHandler(saveProfile);

    // ---- POST /api/profiles/load (activate a stored slot) ----
    auto* loadProfile = new AsyncCallbackJsonWebHandler(
        "/api/profiles/load", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            int slot = body["slot"] | -1;
            Profile p;
            bool loaded;
            { WebStorageLock sl(ctx_);  // serialise LittleFS (loop never waits here)
              loaded = slot >= 0 && ctx_.storage && ctx_.storage->load(slot, p); }
            if (!loaded) {
                doc["ok"] = false;
                doc["error"] = "slot not found";
                sendJson(req, doc, 404);
                return;
            }
            uint32_t cmdId = ctx_.onActivateProfile ? ctx_.onActivateProfile(p) : 0;
            bool queued = cmdId != 0;
            doc["ok"] = queued;
            doc["accepted"] = queued;
            doc["commandId"] = cmdId;
            doc["note"] = queued ? "activation queued" : "invalid profile or queue full";
            sendJson(req, doc, queued ? 202 : 422);
        });
    loadProfile->setMethod(HTTP_POST);
    server_->addHandler(loadProfile);

    // ---- POST /api/profiles/read (read a slot WITHOUT activating it) ----
    // Used by copy / rename / set-startup so an admin action never moves a servo.
    auto* readProfile = new AsyncCallbackJsonWebHandler(
        "/api/profiles/read", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            int slot = body["slot"] | -1;
            Profile p;
            bool loaded;
            { WebStorageLock sl(ctx_);  // serialise LittleFS (loop never waits here)
              loaded = slot >= 0 && ctx_.storage && ctx_.storage->load(slot, p); }
            if (!loaded) {
                JsonDocument err;
                err["ok"] = false;
                err["error"] = "slot not found";
                sendJson(req, err, 404);
                return;
            }
            JsonDocument doc;
            ProfileStorage::toJson(p, doc);  // returned as-is, not activated
            sendJson(req, doc);
        });
    readProfile->setMethod(HTTP_POST);
    server_->addHandler(readProfile);

    // ---- POST /api/profiles/delete ----
    auto* deleteProfile = new AsyncCallbackJsonWebHandler(
        "/api/profiles/delete", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            int slot = body["slot"] | -1;
            WebStorageLock sl(ctx_);  // serialise LittleFS (loop never waits here)
            bool ok = slot >= 0 && ctx_.storage && ctx_.storage->remove(slot);
            doc["ok"] = ok;
            sendJson(req, doc, ok ? 200 : 400);
        });
    deleteProfile->setMethod(HTTP_POST);
    server_->addHandler(deleteProfile);

    // ---- POST /api/test/note (Note On + scheduled Note Off, Ready only) ----
    auto* testNote = new AsyncCallbackJsonWebHandler(
        "/api/test/note", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            uint32_t cmdId = ctx_.onTestNote
                ? ctx_.onTestNote(body["channel"] | 0, body["note"] | 60,
                                  body["velocity"] | 100, body["durationMs"] | 500)
                : 0;
            bool queued = cmdId != 0;
            doc["ok"] = queued;
            doc["accepted"] = queued;
            doc["commandId"] = cmdId;
            doc["note"] = queued ? "test note queued" : "command queue full";
            sendJson(req, doc, queued ? 202 : 503);
        });
    testNote->setMethod(HTTP_POST);
    server_->addHandler(testNote);

    // ---- POST /api/test/servo (pulse a servo to rest/active) ----
    auto* testServo = new AsyncCallbackJsonWebHandler(
        "/api/test/servo", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            if (!ctx_.safety || !ctx_.safety->actuatorsAllowed()) {
                doc["ok"] = false;
                doc["error"] = "actuators not armed";
                sendJson(req, doc, 409);
                return;
            }
            // Never drive a servo from the async task: enqueue for loop(), which
            // also rejects an invalid / disabled index. Optional `us` drives the
            // servo to an exact pulse and holds it (live calibration, incl. a geared
            // finger's side-B press); absent/0 keeps the press/release semantics.
            int idx = body["index"] | -1;
            bool active = body["active"] | true;
            int us = body["us"] | 0;
            // Mechanical IDENTITY resolution (audit 5 P0): the UI's draft indices
            // drift from the ACTIVE profile as soon as a servo is added/removed, so
            // a bare index can move the WRONG actuator. When the request names the
            // servo (function + stringIndex [+ fret]), resolve it against the
            // active ServoBank and refuse when it does not exist there yet.
            if (!body["function"].isNull() && ctx_.servos) {
                std::string fn = body["function"] | "";
                int stringIndex = body["stringIndex"] | -1;
                int fret = body["fret"] | -1;
                int resolved;
                { WebStateLock lk(ctx_);  // the loop may swap the profile/bank
                  resolved = (fn == "finger" && fret >= 1)
                      ? ctx_.servos->fingerIndexForFret(stringIndex, fret)
                      : ctx_.servos->servoIndex(fn, stringIndex); }
                if (resolved < 0) {
                    doc["ok"] = false;
                    doc["error"] = "this actuator is not in the ACTIVE profile — "
                                   "Save & publish before live-testing it";
                    sendJson(req, doc, 409);
                    return;
                }
                // Wiring-drift guard (audit 6): the identity matched, but if the
                // DRAFT's output binding (PCA bus/board/channel or GPIO) differs
                // from the active servo's, the test would drive the OLD wiring
                // while claiming to exercise the new one. Refuse until published.
                if (!body["source"].isNull()) {
                    bool isPca = std::string(body["source"] | "") == "pca";
                    bool match;
                    { WebStateLock lk(ctx_);
                      match = ctx_.servos->bindingMatches(
                          resolved, isPca, body["i2cBus"] | 0, body["pcaBoard"] | 0,
                          body["channel"] | 0, body["gpio"] | -1); }
                    if (!match) {
                        doc["ok"] = false;
                        doc["error"] = "the draft's wiring for this actuator differs "
                                       "from the ACTIVE profile — Save & publish the "
                                       "wiring change before live-testing";
                        sendJson(req, doc, 409);
                        return;
                    }
                }
                idx = resolved;
            }
            uint32_t cmdId = ctx_.onTestServo ? ctx_.onTestServo(idx, active, us) : 0;
            bool queued = cmdId != 0;
            doc["ok"] = queued;
            doc["accepted"] = queued;
            doc["commandId"] = cmdId;
            doc["note"] = queued ? "servo test queued" : "command queue full";
            sendJson(req, doc, queued ? 202 : 503);
        });
    testServo->setMethod(HTTP_POST);
    server_->addHandler(testServo);

    // ---- POST /api/hotspot (switch to AP + captive portal now) ----
    server_->on("/api/hotspot", HTTP_POST, [this](AsyncWebServerRequest* req) {
        if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized";
                            sendJson(req, d, 401); return; }
        JsonDocument doc;
        if (ctx_.onStartHotspot) ctx_.onStartHotspot();
        doc["ok"] = true;
        doc["note"] = "Switching to access point — rejoin the device's Wi-Fi network.";
        // Serviced on the main loop; the station link (and this response's route home)
        // may drop as the radio switches, which is expected.
        sendJson(req, doc, 202);
    });

    // (No stepper jog / endstop routes: servo-per-fret has no carriage or
    // HOME/LIMIT sensors. Per-fret finger calibration uses POST /api/test/servo.)

    // ---- POST /api/wifi (device network settings -> NVS, never exported) ----
    // Carries mode/ssid/apSsid/hostname alongside the write-only passwords, so the
    // network configuration is DEVICE state that survives a reboot independently of
    // any profile slot (audit). `apply:true` asks the main loop to reconnect now.
    auto* setWifi = new AsyncCallbackJsonWebHandler(
        "/api/wifi", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            if (!ctx_.onSetNetwork) {
                doc["ok"] = false;
                sendJson(req, doc, 409);
                return;
            }
            WifiSettings w;
            if (!body["mode"].isNull()) {
                w.hasMode = true;
                w.station = std::string(body["mode"] | "") == "station";
            }
            if (!body["ssid"].isNull()) { w.hasSsid = true; w.ssid = body["ssid"] | ""; }
            if (!body["apSsid"].isNull()) { w.hasApSsid = true; w.apSsid = body["apSsid"] | ""; }
            if (!body["hostname"].isNull()) { w.hasHostname = true; w.hostname = body["hostname"] | ""; }
            // Passwords: a non-empty field overwrites; an empty/absent one keeps the
            // stored secret; clear* explicitly erases it (open network / forget).
            w.hasStationPassword = !body["stationPassword"].isNull() &&
                                   std::string(body["stationPassword"] | "").size() > 0;
            w.stationPassword = body["stationPassword"] | "";
            w.clearStationPassword = body["clearStationPassword"] | false;
            w.hasApPassword = !body["apPassword"].isNull() &&
                              std::string(body["apPassword"] | "").size() > 0;
            w.apPassword = body["apPassword"] | "";
            w.clearApPassword = body["clearApPassword"] | false;
            w.apply = body["apply"] | false;
            // WPA2-PSK requires 8..63 characters; the radio silently starts an OPEN
            // hotspot for anything shorter. Refuse instead of letting the user
            // believe a 1-7 char "password" protects anything (audit follow-up).
            // Empty = keep the stored secret; clearApPassword = deliberately open.
            if (w.hasApPassword &&
                (w.apPassword.size() < 8 || w.apPassword.size() > 63)) {
                doc["ok"] = false;
                doc["error"] =
                    "apPassword must be 8-63 characters (WPA2); leave empty to keep "
                    "the stored one, or set clearApPassword for an open hotspot";
                sendJson(req, doc, 422);
                return;
            }
            // Same upper bound for the station secret (WPA2-PSK passphrase limit).
            if (w.hasStationPassword && w.stationPassword.size() > 63) {
                doc["ok"] = false;
                doc["error"] = "stationPassword exceeds the 63-character WPA2 limit";
                sendJson(req, doc, 422);
                return;
            }
            // 802.11 caps an SSID at 32 bytes; the ESP hostname is similar. Refuse
            // over-long values instead of storing something the radio truncates.
            if ((w.hasSsid && w.ssid.size() > 32) ||
                (w.hasApSsid && w.apSsid.size() > 32)) {
                doc["ok"] = false;
                doc["error"] = "SSID exceeds the 32-character 802.11 limit";
                sendJson(req, doc, 422);
                return;
            }
            if (w.hasApSsid && w.apSsid.empty()) {
                doc["ok"] = false;
                doc["error"] = "the access-point SSID cannot be empty";
                sendJson(req, doc, 422);
                return;
            }
            if (w.hasHostname && w.hostname.size() > 32) {
                doc["ok"] = false;
                doc["error"] = "hostname exceeds 32 characters";
                sendJson(req, doc, 422);
                return;
            }
            if (!ctx_.onSetNetwork(w)) {
                doc["ok"] = false;
                doc["error"] = "storing the network settings failed (NVS write error)";
                sendJson(req, doc, 500);
                return;
            }
            doc["ok"] = true;
            doc["note"] = w.apply ? "stored; applying (hotspot fallback on failure)"
                                  : "stored; applies on reboot";
            sendJson(req, doc, w.apply ? 202 : 200);
        });
    setWifi->setMethod(HTTP_POST);
    server_->addHandler(setWifi);

    // ---- POST /api/midi/source (UDP MIDI source posture, audit 4 P2.3) ----
    // Body: { policy: "open"|"lockToFirst"|"disabled" (optional), unlock: bool }.
    // The policy is stored in NVS (device state, survives reboots) and applied by
    // the main loop; unlock forgets the currently locked sender.
    auto* midiSource = new AsyncCallbackJsonWebHandler(
        "/api/midi/source", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            JsonDocument doc;
            if (!ctx_.onSetMidiSource) {
                doc["ok"] = false;
                sendJson(req, doc, 409);
                return;
            }
            int policy = -1;
            if (!body["policy"].isNull()) {
                std::string p = body["policy"] | "";
                if (p == "open") policy = 0;
                else if (p == "lockToFirst") policy = 1;
                else if (p == "disabled") policy = 2;
                else {
                    doc["ok"] = false;
                    doc["error"] = "policy must be open, lockToFirst or disabled";
                    sendJson(req, doc, 422);
                    return;
                }
            }
            bool unlock = body["unlock"] | false;
            if (!ctx_.onSetMidiSource(policy, unlock)) {
                doc["ok"] = false;
                doc["error"] = "storing the MIDI source policy failed (NVS write error)";
                sendJson(req, doc, 500);
                return;
            }
            doc["ok"] = true;
            sendJson(req, doc);
        });
    midiSource->setMethod(HTTP_POST);
    server_->addHandler(midiSource);

    // ---- GET /api/wifi/scan (survey nearby networks) ----
    // `?start=1` kicks a fresh scan (authorised like every other write); the plain
    // GET returns the latest snapshot: { ok, scanning, networks:[{ssid,rssi,
    // secure,channel}] } deduped by SSID and sorted by RSSI. The UI polls while
    // `scanning` is true.
    server_->on("/api/wifi/scan", HTTP_GET, [this](AsyncWebServerRequest* req) {
        if (!ctx_.wifiScanJson) {
            JsonDocument d; d["ok"] = false; d["error"] = "unsupported";
            sendJson(req, d, 501);
            return;
        }
        if (req->hasParam("start")) {
            if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized"; sendJson(req, d, 401); return; }
            if (ctx_.onWifiScanStart) ctx_.onWifiScanStart();
        }
        req->send(200, "application/json", String(ctx_.wifiScanJson().c_str()));
    });

    // ---- POST /api/auth (set the admin token; first-run bootstrap allowed) ----
    auto* setAuth = new AsyncCallbackJsonWebHandler(
        "/api/auth", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            JsonDocument doc;
            if (!authOk(req)) { doc["ok"] = false; doc["error"] = "unauthorized";
                                sendJson(req, doc, 401); return; }
            if (!ctx_.onSetAdminToken) { doc["ok"] = false; sendJson(req, doc, 409); return; }
            std::string t = body["token"] | "";
            // Reject an empty/too-short token: storing "" would silently leave the
            // write routes unauthenticated (first-run bootstrap state).
            if (t.size() < 8) {
                doc["ok"] = false;
                doc["error"] = "token must be at least 8 characters";
                sendJson(req, doc, 422);
                return;
            }
            if (!ctx_.onSetAdminToken(t)) {
                doc["ok"] = false;
                doc["error"] = "storing the admin token failed (NVS write error)";
                sendJson(req, doc, 500);
                return;
            }
            doc["ok"] = true;
            doc["note"] = "admin token stored";
            sendJson(req, doc);
        });
    setAuth->setMethod(HTTP_POST);
    server_->addHandler(setAuth);

    // ---- POST /api/auth/check (verify a token WITHOUT changing it) ----
    // Lets a NEW browser unlock itself with the EXISTING token: the UI sends the
    // candidate in X-GMB-Token; 200 = valid (the client then remembers it locally),
    // 401 = wrong. Changing the token still goes through POST /api/auth (audit 5).
    server_->on("/api/auth/check", HTTP_POST, [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (!authOk(req)) {
            doc["ok"] = false;
            doc["error"] = "unauthorized";
            sendJson(req, doc, 401);
            return;
        }
        doc["ok"] = true;
        sendJson(req, doc);
    });

    // ---- POST /api/storage/format (deliberate LittleFS reformat) ----
    server_->on("/api/storage/format", HTTP_POST, [this](AsyncWebServerRequest* req) {
        if (!authOk(req)) { JsonDocument d; d["ok"] = false; d["error"] = "unauthorized";
                            sendJson(req, d, 401); return; }
        bool ok;
        { WebStorageLock sl(ctx_);  // serialise with other LittleFS operations
          ok = ctx_.onFormatStorage && ctx_.onFormatStorage(); }
        JsonDocument doc;
        doc["ok"] = ok;
        if (!ok) doc["error"] = "format failed or unavailable";
        sendJson(req, doc, ok ? 200 : 500);
    });

    // ---- POST /api/sysex/request (run a SysEx buffer through the service) ----
    auto* sysexReq = new AsyncCallbackJsonWebHandler(
        "/api/sysex/request", [this](AsyncWebServerRequest* req, JsonVariant& body) {
            JsonDocument doc;
            if (!ctx_.sysex) {
                doc["ok"] = false;
                sendJson(req, doc, 409);
                return;
            }
            std::vector<uint8_t> in;
            for (JsonVariant v : body["bytes"].as<JsonArray>())
                in.push_back(static_cast<uint8_t>(v.as<int>() & 0xFF));
            // Serialise with loop()'s UDP SysEx handling: the service shares a rate
            // limiter and snapshot that are not internally synchronised.
            std::vector<uint8_t> out;
            { WebStateLock lk(ctx_);
              out = ctx_.sysex->handleMessage(in.data(), in.size(), millis()); }
            doc["ok"] = true;
            JsonArray resp = doc["response"].to<JsonArray>();
            for (uint8_t b : out) resp.add(b);
            sendJson(req, doc);
        });
    sysexReq->setMethod(HTTP_POST);
    server_->addHandler(sysexReq);
}

// Built by loop() (the state owner); serialised once and cached under the state
// lock so the async web task only ever reads the immutable copy.
void WebApi::refreshStatus() {
    JsonDocument doc;
    fillStatus(doc);
    String out;
    serializeJson(doc, out);
    if (ctx_.lockState) ctx_.lockState();
    cachedStatus_ = std::string(out.c_str());
    if (ctx_.unlockState) ctx_.unlockState();
}

void WebApi::broadcastStatus() {
    if (statusWs_.count() == 0) return;
    std::string s;
    if (ctx_.lockState) ctx_.lockState();
    s = cachedStatus_;
    if (ctx_.unlockState) ctx_.unlockState();
    statusWs_.textAll(String(s.c_str()));
}

void WebApi::broadcastMidi(const MidiEvent& e) {
    if (midiWs_.count() == 0) return;
    JsonDocument doc;
    doc["timestampUs"] = e.timestampUs;
    doc["source"] = "wifiUdp";
    doc["channel"] = e.channel;
    doc["type"] = midiTypeName(e.type);
    doc["data1"] = e.data1;
    doc["data2"] = e.data2;
    String out;
    serializeJson(doc, out);
    midiWs_.textAll(out);
}

#else  // non-Arduino: no-op so the file is analysable off-target.

void WebApi::begin(const WebContext& ctx, uint16_t) { ctx_ = ctx; }
void WebApi::refreshStatus() {}
void WebApi::broadcastStatus() {}

#endif

}  // namespace gmb
