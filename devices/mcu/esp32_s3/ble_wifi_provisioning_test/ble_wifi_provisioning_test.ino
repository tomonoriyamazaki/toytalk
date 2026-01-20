/*
 * BLE WiFi Provisioning Test
 *
 * ESP32がBLEサーバーとして動作し、スマホアプリからWiFi設定を受け取る
 *
 * 動作:
 * - 起動時: NVSからWiFi設定読み込み → 接続試行
 *   - 成功: 通常動作（LED点灯）
 *   - 失敗/設定なし: 自動でBLEモード
 * - ボタン長押し(3秒): BLEモードに切替
 * - BLEモード: LEDゆっくり点滅、アプリから設定可能
 */

#include <WiFi.h>
#include <esp_wifi.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

// ==== ピン設定 (XIAO ESP32-S3) ====
#define PIN_LED    8
#define PIN_BUTTON 7

// ==== テスト用ハードコード（iPhoneホットスポットテスト） ====
#define TEST_IPHONE_HOTSPOT  true  // trueにするとBLEをスキップしてiPhoneに直接接続
#define TEST_SSID "iPhonezaki"
#define TEST_PASS "00000000"
#define USE_DETAILED_DEBUG true  // 詳細デバッグモード

// ==== BLE UUIDs ====
#define SERVICE_UUID           "12345678-1234-1234-1234-123456789abc"
#define CHAR_SSID_UUID         "12345678-1234-1234-1234-123456789ab1"
#define CHAR_PASSWORD_UUID     "12345678-1234-1234-1234-123456789ab2"
#define CHAR_COMMAND_UUID      "12345678-1234-1234-1234-123456789ab3"
#define CHAR_STATUS_UUID       "12345678-1234-1234-1234-123456789ab4"

// ==== 状態 ====
enum DeviceMode {
  MODE_NORMAL,      // 通常動作（WiFi接続済み）
  MODE_BLE_PROV,    // BLEプロビジョニングモード
  MODE_CONNECTING   // WiFi接続中
};

DeviceMode currentMode = MODE_CONNECTING;
Preferences preferences;

// ==== WiFi設定バッファ ====
String wifiSSID = "";
String wifiPassword = "";
String pendingSSID = "";
String pendingPassword = "";

// ==== BLE ====
BLEServer* pServer = NULL;
BLECharacteristic* pStatusChar = NULL;

// ==== 関数プロトタイプ宣言 ====
void sendStatus(const char* status);
void tryConnectWiFi(const String& ssid, const String& password);
bool deviceConnected = false;
bool oldDeviceConnected = false;

// ==== ボタン ====
unsigned long buttonPressStart = 0;
bool buttonPressed = false;
const unsigned long LONG_PRESS_MS = 3000;

// ==== LED ====
unsigned long lastLedToggle = 0;
bool ledState = false;

// ==== WiFi接続状態（イベントベース） ====
volatile bool wifiConnected = false;
volatile bool wifiGotIP = false;

// ==== WiFiイベントハンドラ ====
void WiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.println("🔷 WiFi: STA started");
      break;
    case ARDUINO_EVENT_WIFI_STA_STOP:
      Serial.println("🔷 WiFi: STA stopped");
      wifiConnected = false;
      wifiGotIP = false;
      break;
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("🔷 WiFi: Connected to AP!");
      wifiConnected = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.printf("🔷 WiFi: Disconnected, reason: %d\n", info.wifi_sta_disconnected.reason);
      wifiConnected = false;
      wifiGotIP = false;
      // 切断理由の詳細
      switch (info.wifi_sta_disconnected.reason) {
        case 2:  Serial.println("   -> AUTH_EXPIRE"); break;
        case 3:  Serial.println("   -> AUTH_LEAVE"); break;
        case 4:  Serial.println("   -> ASSOC_EXPIRE"); break;
        case 5:  Serial.println("   -> ASSOC_TOOMANY"); break;
        case 6:  Serial.println("   -> NOT_AUTHED"); break;
        case 7:  Serial.println("   -> NOT_ASSOCED"); break;
        case 8:  Serial.println("   -> ASSOC_LEAVE"); break;
        case 15: Serial.println("   -> 4WAY_HANDSHAKE_TIMEOUT (wrong password?)"); break;
        case 16: Serial.println("   -> GROUP_KEY_UPDATE_TIMEOUT"); break;
        case 201: Serial.println("   -> NO_AP_FOUND"); break;
        case 202: Serial.println("   -> AUTH_FAIL"); break;
        case 203: Serial.println("   -> ASSOC_FAIL"); break;
        case 204: Serial.println("   -> HANDSHAKE_TIMEOUT"); break;
        default: Serial.printf("   -> Unknown reason %d\n", info.wifi_sta_disconnected.reason); break;
      }
      break;
    case ARDUINO_EVENT_WIFI_STA_AUTHMODE_CHANGE:
      Serial.println("🔷 WiFi: Auth mode changed");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("🔷 WiFi: Got IP: %s\n", WiFi.localIP().toString().c_str());
      wifiGotIP = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP:
      Serial.println("🔷 WiFi: Lost IP");
      wifiGotIP = false;
      break;
    default:
      break;
  }
}

// ==== BLEコールバック ====
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("📱 BLE Client connected");
  }

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("📱 BLE Client disconnected");
    // 再度アドバタイズ開始
    if (currentMode == MODE_BLE_PROV) {
      pServer->startAdvertising();
    }
  }
};

class SSIDCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String value = pCharacteristic->getValue().c_str();
    pendingSSID = value;
    Serial.printf("📝 Received SSID: %s\n", pendingSSID.c_str());
  }
};

class PasswordCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String value = pCharacteristic->getValue().c_str();
    pendingPassword = value;
    Serial.printf("📝 Received Password length: %d\n", pendingPassword.length());
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String value = pCharacteristic->getValue().c_str();
    Serial.printf("📝 Received Command: %s\n", value.c_str());

    if (value == "CONNECT") {
      if (pendingSSID.length() > 0) {
        // WiFi接続を試行
        tryConnectWiFi(pendingSSID, pendingPassword);
      } else {
        sendStatus("ERROR:NO_SSID");
      }
    } else if (value == "SCAN") {
      // WiFiスキャン（将来用）
      sendStatus("SCAN:NOT_IMPLEMENTED");
    }
  }
};

// ==== ステータス送信 ====
void sendStatus(const char* status) {
  if (pStatusChar && deviceConnected) {
    pStatusChar->setValue(status);
    pStatusChar->notify();
    Serial.printf("📤 Status: %s\n", status);
  }
}

// ==== NVS操作 ====
void saveWiFiCredentials(const String& ssid, const String& password) {
  preferences.begin("wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  preferences.end();
  Serial.println("💾 WiFi credentials saved to NVS");
}

bool loadWiFiCredentials() {
  preferences.begin("wifi", true);
  wifiSSID = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("password", "");
  preferences.end();

  if (wifiSSID.length() > 0) {
    Serial.printf("📂 Loaded WiFi: %s\n", wifiSSID.c_str());
    return true;
  }
  Serial.println("📂 No WiFi credentials in NVS");
  return false;
}

// ==== リトライ付きiPhoneホットスポット接続 ====
// Method 1（シンプルなWiFi.begin() + Country=JP）のみ使用し、
// 最大5回リトライすることで信頼性を確保
#if USE_DETAILED_DEBUG
void detailedDebugConnect() {
  Serial.println("\n========================================");
  Serial.println("=== iPhone Hotspot Connection (with retry) ===");
  Serial.println("========================================\n");

  const int MAX_ATTEMPTS = 5;

  for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    Serial.printf("\n🔄 Attempt %d of %d\n", attempt, MAX_ATTEMPTS);
    Serial.println("----------------------------------------");

    // 1. 完全リセット
    wifiConnected = false;
    wifiGotIP = false;
    WiFi.disconnect(true);
    delay(500);  // リセット待ち
    WiFi.mode(WIFI_STA);
    delay(100);

    // 2. 国設定をJPに（ch1-14対応）- 毎回設定
    wifi_country_t country = {
      .cc = "JP",
      .schan = 1,
      .nchan = 14,
      .max_tx_power = 20,
      .policy = WIFI_COUNTRY_POLICY_MANUAL
    };
    esp_wifi_set_country(&country);
    Serial.println("📍 Country set to JP");

    // 3. シンプルにWiFi.begin()のみ
    Serial.printf("📶 Connecting to: %s\n", TEST_SSID);
    WiFi.begin(TEST_SSID, TEST_PASS);

    // 4. 最大15秒待機
    for (int i = 0; i < 15; i++) {
      delay(1000);
      wl_status_t status = WiFi.status();
      Serial.printf("  [%2d] Status: %s | connected=%d gotIP=%d\n",
                   i, getWiFiStatusString(status), wifiConnected, wifiGotIP);

      if (wifiGotIP) {
        Serial.printf("\n✅ SUCCESS on attempt %d! IP: %s\n", attempt, WiFi.localIP().toString().c_str());
        return;
      }
    }

    Serial.printf("❌ Attempt %d failed\n", attempt);

    // 次のリトライ前に待機（最後の試行後は不要）
    if (attempt < MAX_ATTEMPTS) {
      Serial.println("⏳ Waiting 2 seconds before next attempt...");
      delay(2000);
    }
  }

  Serial.println("\n❌ All attempts failed");
  Serial.println("========================================\n");
}
#endif

// ==== WiFiステータスを文字列に変換 ====
const char* getWiFiStatusString(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS:     return "IDLE";
    case WL_NO_SSID_AVAIL:   return "NO_SSID_AVAIL";
    case WL_SCAN_COMPLETED:  return "SCAN_COMPLETED";
    case WL_CONNECTED:       return "CONNECTED";
    case WL_CONNECT_FAILED:  return "CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED:    return "DISCONNECTED";
    default:                 return "UNKNOWN";
  }
}

// ==== WiFiスキャン ====
void scanWiFiNetworks() {
  Serial.println("🔍 Scanning WiFi networks...");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  int n = WiFi.scanNetworks();
  Serial.printf("🔍 Found %d networks:\n", n);

  for (int i = 0; i < n; i++) {
    Serial.printf("  [%d] %s (RSSI: %d, Ch: %d, %s)\n",
      i + 1,
      WiFi.SSID(i).c_str(),
      WiFi.RSSI(i),
      WiFi.channel(i),
      WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "Open" : "Encrypted"
    );
  }

  WiFi.scanDelete();
}

// ==== WiFi接続（1回試行） - Country=JP + シンプルWiFi.begin() ====
bool tryConnectWiFiOnce(const String& ssid, const String& password) {
  // フラグリセット
  wifiConnected = false;
  wifiGotIP = false;

  // 完全リセット
  WiFi.disconnect(true);
  delay(500);  // リセット待ち
  WiFi.mode(WIFI_STA);
  delay(100);

  // 国設定をJPに（iPhoneホットスポット対応）
  wifi_country_t country = {
    .cc = "JP",
    .schan = 1,
    .nchan = 14,
    .max_tx_power = 20,
    .policy = WIFI_COUNTRY_POLICY_MANUAL
  };
  esp_wifi_set_country(&country);

  Serial.printf("📶 Connecting to: %s\n", ssid.c_str());
  Serial.printf("📶 Password length: %d\n", password.length());

  WiFi.begin(ssid.c_str(), password.c_str());
  Serial.println("📶 WiFi.begin() called (Country=JP)");

  // 最大15秒待機（1秒刻み）
  for (int i = 0; i < 15; i++) {
    delay(1000);
    Serial.print(".");
    if (wifiGotIP) {
      break;
    }
  }

  Serial.printf("\n📶 Result: connected=%d, gotIP=%d\n", wifiConnected, wifiGotIP);
  return wifiGotIP;
}

// ==== WiFi接続（リトライ付き） ====
void tryConnectWiFi(const String& ssid, const String& password) {
  Serial.printf("📶 Connecting to WiFi: %s\n", ssid.c_str());
  Serial.printf("📶 Password length: %d\n", password.length());

  // スキャンなしで直接接続（demo_v1.3方式）
  sendStatus("CONNECTING");

  // 最大5回リトライ（iPhoneホットスポット対応）
  const int MAX_RETRIES = 5;
  for (int retry = 1; retry <= MAX_RETRIES; retry++) {
    Serial.printf("\n🔄 Attempt %d of %d\n", retry, MAX_RETRIES);

    if (tryConnectWiFiOnce(ssid, password)) {
      // 成功
      Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

      // NVSに保存
      saveWiFiCredentials(ssid, password);
      wifiSSID = ssid;
      wifiPassword = password;

      sendStatus("CONNECTED");

      // 少し待ってからBLE停止、通常モードへ
      delay(1000);
      stopBLE();
      currentMode = MODE_NORMAL;
      digitalWrite(PIN_LED, HIGH);  // LED点灯
      return;
    }

    wl_status_t status = WiFi.status();
    Serial.printf("\n❌ Attempt %d failed: %s\n", retry, getWiFiStatusString(status));

    // SSIDが見つからない場合はリトライしない
    if (status == WL_NO_SSID_AVAIL) {
      Serial.println("⚠️ SSID not found, stopping retries");
      break;
    }

    // 次のリトライ前に待機
    if (retry < MAX_RETRIES) {
      Serial.println("⏳ Waiting 3 seconds before retry...");
      delay(3000);
    }
  }

  Serial.println("\n❌ WiFi connection failed after all retries");
  sendStatus("FAILED");
}

// ==== BLE開始/停止 ====
void startBLE() {
  Serial.println("🔵 Starting BLE...");

  BLEDevice::init("ToyTalk-Setup");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  // サービス作成
  BLEService* pService = pServer->createService(SERVICE_UUID);

  // SSIDキャラクタリスティック
  BLECharacteristic* pSSIDChar = pService->createCharacteristic(
    CHAR_SSID_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pSSIDChar->setCallbacks(new SSIDCallbacks());

  // Passwordキャラクタリスティック
  BLECharacteristic* pPasswordChar = pService->createCharacteristic(
    CHAR_PASSWORD_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pPasswordChar->setCallbacks(new PasswordCallbacks());

  // Commandキャラクタリスティック
  BLECharacteristic* pCommandChar = pService->createCharacteristic(
    CHAR_COMMAND_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pCommandChar->setCallbacks(new CommandCallbacks());

  // Statusキャラクタリスティック（Notify）
  pStatusChar = pService->createCharacteristic(
    CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pStatusChar->addDescriptor(new BLE2902());
  pStatusChar->setValue("READY");

  pService->start();

  // アドバタイジング開始
  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("🔵 BLE advertising started - Device name: ToyTalk-Setup");
  currentMode = MODE_BLE_PROV;
}

void stopBLE() {
  Serial.println("🔵 Stopping BLE...");
  BLEDevice::deinit(true);
  pServer = NULL;
  pStatusChar = NULL;
  deviceConnected = false;
}

// ==== LED更新 ====
void updateLED() {
  if (currentMode == MODE_BLE_PROV) {
    // ゆっくり点滅（500ms間隔）
    if (millis() - lastLedToggle > 500) {
      ledState = !ledState;
      digitalWrite(PIN_LED, ledState ? HIGH : LOW);
      lastLedToggle = millis();
    }
  } else if (currentMode == MODE_CONNECTING) {
    // 速い点滅（100ms間隔）
    if (millis() - lastLedToggle > 100) {
      ledState = !ledState;
      digitalWrite(PIN_LED, ledState ? HIGH : LOW);
      lastLedToggle = millis();
    }
  }
  // MODE_NORMALはsetup/接続成功時に点灯済み
}

// ==== ボタン処理 ====
void handleButton() {
  bool pressed = (digitalRead(PIN_BUTTON) == LOW);

  if (pressed && !buttonPressed) {
    // 押下開始
    buttonPressStart = millis();
    buttonPressed = true;
  } else if (!pressed && buttonPressed) {
    // 離した
    buttonPressed = false;
  } else if (pressed && buttonPressed) {
    // 長押し判定
    if (millis() - buttonPressStart >= LONG_PRESS_MS) {
      if (currentMode == MODE_NORMAL) {
        Serial.println("🔘 Long press detected - Entering BLE mode");
        WiFi.disconnect(true);
        startBLE();
      }
      buttonPressed = false;  // 一度だけトリガー
    }
  }
}

// ==== SETUP ====
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n🚀 BLE WiFi Provisioning Test");

  // WiFiイベントハンドラ登録
  WiFi.onEvent(WiFiEvent);

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  digitalWrite(PIN_LED, LOW);

#if TEST_IPHONE_HOTSPOT
  // ==== iPhoneホットスポット直接テスト ====
  Serial.println("🧪 TEST MODE: iPhone hotspot detailed debug");

  #if USE_DETAILED_DEBUG
    // 詳細デバッグモード
    detailedDebugConnect();
  #else
    // シンプルモード
    Serial.printf("🧪 SSID: %s\n", TEST_SSID);
    Serial.printf("🧪 Password length: %d\n", strlen(TEST_PASS));
    currentMode = MODE_CONNECTING;
    tryConnectWiFi(TEST_SSID, TEST_PASS);
  #endif

  if (wifiGotIP) {
    Serial.println("✅ iPhone hotspot test SUCCESS!");
    currentMode = MODE_NORMAL;
    digitalWrite(PIN_LED, HIGH);
  } else {
    Serial.println("❌ iPhone hotspot test FAILED");
  }
#else
  // ==== 通常モード ====
  // NVSからWiFi設定読み込み
  if (loadWiFiCredentials()) {
    // 設定あり → 接続試行
    currentMode = MODE_CONNECTING;
    tryConnectWiFi(wifiSSID, wifiPassword);

    if (!wifiGotIP) {
      // 接続失敗 → BLEモード
      Serial.println("⚠️ WiFi failed, entering BLE provisioning mode");
      startBLE();
    }
  } else {
    // 設定なし → BLEモード
    Serial.println("⚠️ No WiFi config, entering BLE provisioning mode");
    startBLE();
  }
#endif
}

// ==== LOOP ====
void loop() {
  handleButton();
  updateLED();

  // BLEモード時の接続状態変化処理
  if (currentMode == MODE_BLE_PROV) {
    if (!deviceConnected && oldDeviceConnected) {
      delay(500);
      if (pServer) {
        pServer->startAdvertising();
      }
    }
    oldDeviceConnected = deviceConnected;
  }

  delay(10);
}
