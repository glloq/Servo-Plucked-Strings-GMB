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
  Serial.println("Initializing PCA9685 controllers...");
  #endif

  // Initialiser I2C si pas déjà fait
  Wire.begin();
  Wire.setClock(I2C_FREQUENCY);

  // Initialiser le pin OE (Output Enable)
  pinMode(PIN_OE, OUTPUT);
  disablePower();  // Démarrer avec servos désactivés

  // Initialiser chaque contrôleur
  bool allOk = true;
  for (int i = 0; i < PCA_COUNT; i++) {
    if (!initController(i)) {
      allOk = false;
    }
  }

  #ifdef DEBUG
  if (allOk) {
    Serial.println("All PCA9685 initialized successfully");
  } else {
    Serial.println("WARNING: Some PCA9685 failed to initialize");
  }
  #endif

  return allOk;
}

bool PCA9685Manager::initController(uint8_t index) {
  if (index >= PCA_COUNT) {
    #ifdef DEBUG
    Serial.print("ERROR: Invalid PCA index: ");
    Serial.println(index);
    #endif
    return false;
  }

  uint8_t addr = PCA9685_BASE_ADDR + index;

  #ifdef DEBUG
  Serial.print("Init PCA9685 #");
  Serial.print(index);
  Serial.print(" @ 0x");
  Serial.println(addr, HEX);
  #endif

  // Créer l'objet
  controllers[index] = new Adafruit_PWMServoDriver(addr);

  if (controllers[index] == nullptr) {
    #ifdef DEBUG
    Serial.println("  ERROR: Failed to allocate memory");
    #endif
    return false;
  }

  // Initialiser
  controllers[index]->begin();
  controllers[index]->setPWMFreq(SERVO_FREQ);

  delay(10);  // Stabilisation

  initialized[index] = true;

  #ifdef DEBUG
  Serial.println("  OK");
  #endif

  return true;
}

bool PCA9685Manager::setPWM(uint8_t pcaIndex, uint8_t pin, uint16_t value) {
  if (pcaIndex >= PCA_COUNT) {
    #ifdef DEBUG
    Serial.println("ERROR: Invalid PCA index");
    #endif
    return false;
  }

  if (!initialized[pcaIndex]) {
    #ifdef DEBUG
    Serial.print("ERROR: PCA ");
    Serial.print(pcaIndex);
    Serial.println(" not initialized");
    #endif
    return false;
  }

  if (pin > 15) {
    #ifdef DEBUG
    Serial.println("ERROR: Invalid pin (0-15)");
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
  // Limiter l'angle
  if (angle > 180) {
    angle = 180;
  }

  // Conversion linéaire 0-180° → SERVO_MIN_PULSE-SERVO_MAX_PULSE
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
  // OE est inversé: LOW = enable, HIGH = disable
  digitalWrite(PIN_OE, LOW);

  #ifdef DEBUG_VERBOSE
  Serial.println("Servo power ENABLED");
  #endif
}

void PCA9685Manager::disablePower() {
  // OE est inversé: LOW = enable, HIGH = disable
  digitalWrite(PIN_OE, HIGH);

  #ifdef DEBUG_VERBOSE
  Serial.println("Servo power DISABLED");
  #endif
}
