#include "PCA9685Manager.h"

PCA9685Manager::PCA9685Manager() {
  for (int i = 0; i < PCA_COUNT; i++) {
    controllers[i] = nullptr;
    initialized[i] = false;
  }
}

PCA9685Manager::~PCA9685Manager() {
  for (int i = 0; i < PCA_COUNT; i++) {
    if (controllers[i] != nullptr) {
      delete controllers[i];
    }
  }
}

bool PCA9685Manager::init() {
  #ifdef DEBUG
  Serial.println(F("Initializing PCA9685 controllers..."));
  #endif

  // Initialize I2C if not already done
  Wire.begin();
  Wire.setClock(I2C_FREQUENCY);

  // Initialize the OE pin (Output Enable)
  pinMode(PIN_OE, OUTPUT);
  disablePower();  // Start with servos disabled

  // Initialize each controller
  bool allOk = true;
  for (int i = 0; i < PCA_COUNT; i++) {
    if (!initController(i)) {
      allOk = false;
    }
  }

  #ifdef DEBUG
  if (allOk) {
    Serial.println(F("All PCA9685 initialized successfully"));
  } else {
    Serial.println(F("WARNING: Some PCA9685 failed to initialize"));
  }
  #endif

  return allOk;
}

bool PCA9685Manager::initController(uint8_t index) {
  if (index >= PCA_COUNT) {
    #ifdef DEBUG
    Serial.print(F("ERROR: Invalid PCA index: "));
    Serial.println(index);
    #endif
    return false;
  }

  uint8_t addr = PCA9685_BASE_ADDR + index;

  #ifdef DEBUG
  Serial.print(F("Init PCA9685 #"));
  Serial.print(index);
  Serial.print(F(" @ 0x"));
  Serial.println(addr, HEX);
  #endif

  // Create the object
  controllers[index] = new Adafruit_PWMServoDriver(addr);

  if (controllers[index] == nullptr) {
    #ifdef DEBUG
    Serial.println(F("  ERROR: Failed to allocate memory"));
    #endif
    return false;
  }

  // Initialize
  controllers[index]->begin();
  controllers[index]->setPWMFreq(SERVO_FREQ);

  delay(10);  // Stabilization

  initialized[index] = true;

  #ifdef DEBUG
  Serial.println(F("  OK"));
  #endif

  return true;
}

bool PCA9685Manager::setPWM(uint8_t pcaIndex, uint8_t pin, uint16_t value) {
  if (pcaIndex >= PCA_COUNT) {
    #ifdef DEBUG
    Serial.println(F("ERROR: Invalid PCA index"));
    #endif
    return false;
  }

  if (!initialized[pcaIndex]) {
    #ifdef DEBUG
    Serial.print(F("ERROR: PCA "));
    Serial.print(pcaIndex);
    Serial.println(F(" not initialized"));
    #endif
    return false;
  }

  if (pin > 15) {
    #ifdef DEBUG
    Serial.println(F("ERROR: Invalid pin (0-15)"));
    #endif
    return false;
  }

  controllers[pcaIndex]->setPWM(pin, 0, value);
  return true;
}

bool PCA9685Manager::setAngle(uint8_t pcaIndex, uint8_t pin, uint16_t angle) {
  uint16_t pwm = angleToPWM(angle);
  return setPWM(pcaIndex, pin, pwm);
}

uint16_t PCA9685Manager::angleToPWM(uint16_t angle) {
  // Limit the angle
  if (angle > 180) {
    angle = 180;
  }

  // Linear conversion 0-180° → SERVO_MIN_PULSE-SERVO_MAX_PULSE
  uint16_t pulse = map(angle, 0, 180, SERVO_MIN_PULSE, SERVO_MAX_PULSE);

  return pulse;
}

bool PCA9685Manager::isInitialized(uint8_t pcaIndex) {
  if (pcaIndex >= PCA_COUNT) {
    return false;
  }
  return initialized[pcaIndex];
}

void PCA9685Manager::enablePower() {
  // OE is inverted: LOW = enable, HIGH = disable
  digitalWrite(PIN_OE, LOW);

  #ifdef DEBUG_VERBOSE
  Serial.println(F("Servo power ENABLED"));
  #endif
}

void PCA9685Manager::disablePower() {
  // OE is inverted: LOW = enable, HIGH = disable
  digitalWrite(PIN_OE, HIGH);

  #ifdef DEBUG_VERBOSE
  Serial.println(F("Servo power DISABLED"));
  #endif
}
