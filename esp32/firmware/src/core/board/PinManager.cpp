#include "PinManager.h"

#include <string>

namespace gmb {

namespace {
bool startsWith(const std::string& s, const char* p) {
    return s.rfind(p, 0) == 0;
}
}  // namespace

SignalKind signalKindFromName(const std::string& signal) {
    if (startsWith(signal, "ENABLE")) return SignalKind::Enable;
    if (signal == "SDA") return SignalKind::I2cSda;
    if (signal == "SCL") return SignalKind::I2cScl;
    if (startsWith(signal, "SERVO_OE") || signal == "OE") return SignalKind::ServoOe;
    return SignalKind::Generic;
}

bool PinManager::isUsed(int8_t gpio, const std::string& exceptSignal) const {
    for (const auto& a : assignments_) {
        if (a.signal != exceptSignal && a.gpio == gpio) return true;
    }
    return false;
}

int8_t PinManager::gpioOf(const std::string& signal) const {
    for (const auto& a : assignments_) {
        if (a.signal == signal) return a.gpio;
    }
    return kNoPin;
}

void PinManager::assign(const std::string& signal, SignalKind kind, int8_t gpio) {
    for (auto& a : assignments_) {
        if (a.signal == signal) {
            a.kind = kind;
            a.gpio = gpio;
            return;
        }
    }
    assignments_.push_back({signal, kind, gpio});
}

bool PinManager::place(const std::string& signal, SignalKind kind,
                       const std::vector<int8_t>& preferred) {
    // Try the recommended pins first.
    for (int8_t gpio : preferred) {
        if (board_.supports(gpio, kind) && !isUsed(gpio)) {
            assignments_.push_back({signal, kind, gpio});
            return true;
        }
    }
    // Fall back to any compatible, unused candidate.
    for (const PinCapability* c : board_.candidatesFor(kind)) {
        if (!isUsed(c->gpio)) {
            assignments_.push_back({signal, kind, c->gpio});
            return true;
        }
    }
    return false;
}

bool PinManager::autoAssign(const PinRequest& req) {
    clear();
    bool ok = true;
    // Servo-per-fret drives every finger/plucker over the PCA9685 I2C bus (or a
    // direct GPIO carried by the servo entry), so the only board-level pins to
    // place are the I2C bus and the /OE safety line — no per-string STEP/DIR/HOME.
    if (req.useI2cServos) {
        ok &= place("SDA", SignalKind::I2cSda, {40});
        ok &= place("SCL", SignalKind::I2cScl, {41});
    }
    if (req.servoSafetyOe) {
        ok &= place("SERVO_OE", SignalKind::ServoOe, {47});
    }
    return ok;
}

std::vector<PinError> PinManager::validate(bool reserveUsb) const {
    std::vector<PinError> errors;

    for (const auto& a : assignments_) {
        const PinCapability* cap = board_.find(a.gpio);

        // Unknown / not exposed on this board.
        if (cap == nullptr || !cap->exposed) {
            errors.push_back({a.signal, a.gpio,
                              "GPIO not available on this board variant",
                              "Pick a pin listed for this board", ""});
            continue;
        }

        // USB reservation (spec 11.3).
        if (reserveUsb && cap->usb) {
            errors.push_back({a.signal, a.gpio,
                              "Reserved for future native USB (GPIO19/20)",
                              "Choose another output pin", ""});
        }

        // Reserved / Flash / PSRAM / strapping / on-board peripheral.
        if (cap->reserved) {
            std::string why = cap->note.empty() ? "Pin is reserved" : cap->note;
            errors.push_back({a.signal, a.gpio, why,
                              "Choose a recommended (green) pin", ""});
        }

        // Signal / capability mismatch.
        if (!board_.supports(a.gpio, a.kind)) {
            std::string why = "Pin cannot carry this signal type";
            if (a.kind == SignalKind::I2cSda || a.kind == SignalKind::I2cScl) {
                why = "Pin cannot be used for the open-drain I2C bus";
            }
            errors.push_back({a.signal, a.gpio, why,
                              "Pick a pin compatible with this function", ""});
        }
    }

    // Duplicate GPIO detection (two signals on the same pin).
    for (size_t i = 0; i < assignments_.size(); ++i) {
        if (assignments_[i].gpio < 0) continue;
        for (size_t j = i + 1; j < assignments_.size(); ++j) {
            if (assignments_[i].gpio == assignments_[j].gpio) {
                errors.push_back({assignments_[j].signal, assignments_[j].gpio,
                                  "GPIO already used by another signal",
                                  "Assign a different free pin",
                                  assignments_[i].signal});
            }
        }
    }

    return errors;
}

}  // namespace gmb
