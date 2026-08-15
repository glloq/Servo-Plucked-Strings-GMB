// Wi-Fi management: AP for first setup, station for normal use, automatic
// fallback to AP after repeated failures (spec §8.1).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../../core/configuration/Profile.h"

#if defined(ARDUINO)
#include <DNSServer.h>
#endif

namespace gmb {

class Net {
public:
    // Passwords are supplied separately from the Profile so they are never
    // stored in exportable config (spec §20). An empty apPassword
    // leaves the access point open.
    // Calling begin() again RECONFIGURES the link live (used when the Settings
    // modal stores new device network settings): failure counters and any forced-
    // hotspot latch reset, then the station attempt / AP starts over with the new
    // config — with the usual automatic fallback to the hotspot on failure.
    bool begin(const NetworkConfig& cfg, const std::string& stationPassword,
               const std::string& apPassword = "");

    // Poll connection state; returns to AP mode after repeated station failures.
    // Also pumps the captive-portal DNS while the access point is up and harvests
    // a finished background Wi-Fi scan.
    void tick(uint32_t nowMs);

    // Switch to the access point (hardware BOOT button / web "Start hotspot"),
    // regardless of the configured mode, and keep it up (no station retry) until
    // the next reboot. Brings the captive portal with it so a phone that joins is
    // taken straight to the config page. Safe to call repeatedly.
    // NON-BLOCKING: the radio mode is set here and softAP() fires from a later
    // tick(), once the settle window has elapsed.
    void forceAccessPoint(uint32_t nowMs);

    // ---- Wi-Fi survey (Settings modal network picker) ----------------------
    // Asynchronous scan of nearby networks from the station interface; while the
    // AP is up the radio switches to AP+STA so the hotspot (and the browser
    // session on it) survives the scan. Results are deduplicated by SSID (the
    // strongest signal wins) and sorted by RSSI. tick() harvests completion;
    // scanGeneration() bumps each time fresh results land, so the owner can
    // re-serialize without a callback.
    struct ScanResult {
        std::string ssid;
        int32_t rssi = 0;
        bool secure = false;  // any encryption (an open network needs no password)
        int32_t channel = 0;
    };
    bool startScan();  // false when a scan is already running
    bool scanInProgress() const { return scanning_; }
    uint32_t scanGeneration() const { return scanGeneration_; }
    const std::vector<ScanResult>& scanResults() const { return scanResults_; }

    bool connected() const { return connected_; }
    bool accessPointActive() const { return apActive_; }
    // True while the access point is starting: WiFi.mode(WIFI_AP) has been issued
    // and softAP() waits for the netif settle window. Nothing blocks — tick()
    // finishes the bring-up (see kApSettleMs).
    bool accessPointPending() const { return apPending_; }
    // True only when the AP is up AND protected by a WPA2 password (>= 8 chars).
    bool accessPointSecured() const { return apActive_ && apPassword_.size() >= 8; }
    std::string ipAddress() const { return ip_; }
    std::string mode() const { return apActive_ ? "accessPoint" : "station"; }

private:
    NetworkConfig cfg_;
    std::string password_;
    std::string apPassword_;
    bool connected_ = false;
    bool apActive_ = false;
    bool connecting_ = false;
    bool apIsFallback_ = false;  // AP entered because station failed (retry later)
    bool apForced_ = false;      // AP entered on demand: never auto-retry station
    std::string ip_;
    int failures_ = 0;
    uint32_t attemptStartMs_ = 0;
    uint32_t lastStationRetryMs_ = 0;
    bool dnsActive_ = false;     // captive-portal DNS running (AP only)
    // Non-blocking access-point bring-up (audit P1). The classic ESP32 wants a
    // short settle between WiFi.mode(WIFI_AP) and softAP(); that used to be a
    // delay(100) reachable from tick(), i.e. from loop(), i.e. able to hold the
    // E-stop poll for 100 ms. It is a two-step FSM now: mode set here, softAP()
    // issued by a later tick().
    bool apPending_ = false;         // mode set, waiting for the settle window
    bool apPendingFallback_ = false; // the `fallback` flag of the pending request
    uint32_t apPendingSinceMs_ = 0;
    bool scanning_ = false;              // async Wi-Fi scan in flight
    uint32_t scanGeneration_ = 0;        // bumps when fresh scan results land
    std::vector<ScanResult> scanResults_;
#if defined(ARDUINO)
    DNSServer dns_;              // captive portal: resolves every name to the AP IP
#endif
    void startCaptivePortal();   // start the wildcard DNS (call after softAP is up)
    void stopCaptivePortal();    // stop it (call when leaving AP for station)

    // Step 1 of the AP bring-up: set the radio mode and arm the settle window.
    void startAccessPoint(uint32_t nowMs, bool fallback = false);
    // Step 2: called by tick() once the window has elapsed — issues softAP() and
    // brings the captive portal up. Returns true when the AP is live.
    bool finishAccessPoint();
    // Service the pending bring-up; true while one is still in flight.
    bool serviceAccessPointStart(uint32_t nowMs);
    void beginStationAttempt(uint32_t nowMs);  // non-blocking: kicks off WiFi.begin
    bool pollStation(uint32_t nowMs);          // returns true once connected
    void pollScan();                           // harvest a finished background scan
};

}  // namespace gmb
