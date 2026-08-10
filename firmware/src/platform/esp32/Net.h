// Wi-Fi management: AP for first setup, station for normal use, automatic
// fallback to AP after repeated failures (spec §8.1).
#pragma once

#include <cstdint>
#include <string>

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
    bool begin(const NetworkConfig& cfg, const std::string& stationPassword,
               const std::string& apPassword = "");

    // Poll connection state; returns to AP mode after repeated station failures.
    // Also pumps the captive-portal DNS while the access point is up.
    void tick(uint32_t nowMs);

    // Switch to the access point NOW (hardware BOOT button / web "Start hotspot"),
    // regardless of the configured mode, and keep it up (no station retry) until
    // the next reboot. Brings the captive portal with it so a phone that joins is
    // taken straight to the config page. Safe to call repeatedly.
    void forceAccessPoint();

    bool connected() const { return connected_; }
    bool accessPointActive() const { return apActive_; }
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
#if defined(ARDUINO)
    DNSServer dns_;              // captive portal: resolves every name to the AP IP
#endif
    void startCaptivePortal();   // start the wildcard DNS (call after softAP is up)
    void stopCaptivePortal();    // stop it (call when leaving AP for station)

    void startAccessPoint(bool fallback = false);
    void beginStationAttempt(uint32_t nowMs);  // non-blocking: kicks off WiFi.begin
    bool pollStation(uint32_t nowMs);          // returns true once connected
};

}  // namespace gmb
