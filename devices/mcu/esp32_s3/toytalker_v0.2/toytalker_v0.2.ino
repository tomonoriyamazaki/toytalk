#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <esp_wifi.h>
#include <BLEDevice.h>                                   
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

// ==== デバッグ設定 ====
#define DEBUG_MEMORY 0  // メモリ診断を有効化する場合は1に設定

// ==== WiFi（NVSから読み込み） ====
String wifiSSID = "";
String wifiPassword = "";
String pendingSSID = "";
String pendingPassword = "";
Preferences preferences;

// ==== BLE UUIDs（アプリ側toy.tsxと一致） ====
#define SERVICE_UUID           "12345678-1234-1234-1234-123456789abc"
#define CHAR_SSID_UUID         "12345678-1234-1234-1234-123456789ab1"
#define CHAR_PASSWORD_UUID     "12345678-1234-1234-1234-123456789ab2"
#define CHAR_COMMAND_UUID      "12345678-1234-1234-1234-123456789ab3"
#define CHAR_STATUS_UUID       "12345678-1234-1234-1234-123456789ab4"
#define CHAR_MAC_UUID          "12345678-1234-1234-1234-123456789ab5"

// ==== デバイスモード ====
enum DeviceMode {
  MODE_NORMAL,      // 通常動作（会話機能）
  MODE_BLE_PROV,    // BLEプロビジョニング
  MODE_CONNECTING   // WiFi接続中
};
DeviceMode currentMode = MODE_CONNECTING;

// ==== BLE ====
BLEServer* pServer = NULL;
BLECharacteristic* pStatusChar = NULL;
bool bleDeviceConnected = false;
bool oldBleDeviceConnected = false;
String deviceMacAddress = "";

// ==== Lambda (TTS) - Binary Streaming ====
const char* LAMBDA_HOST = "koufofwm3w4tidbe52crbyhpyq0cshss.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== Lambda (Soniox Key) ====
const char* SONIOX_LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;

// ==== I2S PIN ====
#define PIN_WS     3
#define PIN_BCLK   4
#define PIN_DATA   9
#define PIN_DOUT   5
#define PIN_AMP_SD 6
#define SAMPLE_RATE_STT 16000
#define SAMPLE_RATE_TTS 24000


// ==== LED & Button ====
#define PIN_LED    8
#define PIN_BUTTON 7
#define LED_CHANNEL 0
#define LED_FREQ 5000
#define LED_RESOLUTION 8

// LED状態
enum LEDMode {
  LED_OFF,
  LED_ON,
  LED_BREATHING,  // ふわふわ（録音中）
  LED_BLINKING    // 点滅（再生中）
};

LEDMode currentLEDMode = LED_OFF;
unsigned long lastLEDUpdate = 0;
int breathingValue = 0;
bool breathingUp = true;
bool blinkState = false;
bool ampOn = false;  // アンプON状態管理（ソフトスタート用）

// ボタン状態
int lastButtonReading = HIGH;
int buttonState = HIGH;
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

// ボタン長押し（BLEモード切替用）
unsigned long buttonPressStart = 0;
bool buttonLongPressTriggered = false;
const unsigned long LONG_PRESS_MS = 3000;

// ==== WiFi接続状態（イベントベース） ====
volatile bool wifiConnected = false;
volatile bool wifiGotIP = false;

// ==== Soniox STT 状態 ====
WebSocketsClient ws;
String partialText = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;
bool isRecording = false;
bool endpointDetected = false;  // Sonioxの<end>トークン検出フラグ

// ==== TTS 受信状態 ====
int curSegmentId = -1;
String responseText = "";
uint8_t* currentPcmBuffer = NULL;
size_t currentPcmSize = 0;

// ==== セッションID（電源ON/OFF単位） ====
String sessionId = "";

// ==== 会話履歴 (直近5回分) ====
const int MAX_HISTORY = 5;
struct Message {
  String role;
  String content;
};
Message conversationHistory[MAX_HISTORY * 2];
int historyCount = 0;

// ==== 音量調整 ====
const float VOLUME = 1.0;

// ==== TTS設定（DynamoDB連携予定）====
// TTS_PROVIDER候補: "OpenAI" / "Google" / "Gemini" / "ElevenLabs"
const char* TTS_PROVIDER = "ElevenLabs";
// TTS_CHARACTER: "default"の場合、各TTSのデフォルトキャラクターを使用
// ElevenLabs: Sameno（子供向け）, OpenAI: nova, Google: ja-JP-Neural2-C, Gemini: Kore
const char* TTS_CHARACTER = "default";

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
        case 15: Serial.println("   -> 4WAY_HANDSHAKE_TIMEOUT (wrong password?)"); break;
        case 201: Serial.println("   -> NO_AP_FOUND"); break;
        case 202: Serial.println("   -> AUTH_FAIL"); break;
        default: break;
      }
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

// ==== NVS操作 ====
void saveWiFiCredentials(const String& ssid, const String& password) {
  preferences.begin("wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  preferences.end();
  Serial.println("💾 WiFi credentials saved to NVS");
}

void saveDeviceMac(const String& mac) {
  preferences.begin("device", false);
  preferences.putString("mac", mac);
  preferences.end();
  Serial.printf("💾 Device MAC saved to NVS: %s\n", mac.c_str());
}

String loadDeviceMac() {
  preferences.begin("device", true);
  String mac = preferences.getString("mac", "");
  preferences.end();
  return mac;
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

// ==== BLEステータス送信 ====
void sendBLEStatus(const char* status) {
  if (pStatusChar && bleDeviceConnected) {
    pStatusChar->setValue(status);
    pStatusChar->notify();
    Serial.printf("📤 BLE Status: %s\n", status);
  }
}

// ==== 前方宣言 ====
void tryConnectWiFiFromBLE(const String& ssid, const String& password);
void startNormalOperation();

// ==== BLEコールバック ====
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleDeviceConnected = true;
    Serial.println("📱 BLE Client connected");
  }

  void onDisconnect(BLEServer* pServer) {
    bleDeviceConnected = false;
    Serial.println("📱 BLE Client disconnected");
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
        tryConnectWiFiFromBLE(pendingSSID, pendingPassword);
      } else {
        sendBLEStatus("ERROR:NO_SSID");
      }
    }
  }
};

// ==== BLE開始 ====
void startBLE() {
  Serial.println("🔵 Starting BLE...");

  BLEDevice::init("ToyTalk-Setup");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

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

  // MACアドレスキャラクタリスティック（Read only）
  BLECharacteristic* pMacChar = pService->createCharacteristic(
    CHAR_MAC_UUID,
    BLECharacteristic::PROPERTY_READ
  );
  deviceMacAddress = BLEDevice::getAddress().toString().c_str();
  pMacChar->setValue(deviceMacAddress.c_str());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("🔵 BLE advertising started - Device name: ToyTalk-Setup");
  currentMode = MODE_BLE_PROV;
  setLEDMode(LED_BLINKING);  // BLEモード中は点滅
}

// ==== BLE停止 ====
void stopBLE() {
  Serial.println("🔵 Stopping BLE...");
  BLEDevice::deinit(true);
  pServer = NULL;
  pStatusChar = NULL;
  bleDeviceConnected = false;
}

// ==== メモリ診断関数 ====
#if DEBUG_MEMORY
void printMemoryStatus(const char* label) {
  Serial.println("========================================");
  Serial.printf("[MEMORY] %s\n", label);
  Serial.println("========================================");

  // 総合メモリ情報
  Serial.printf("Total Heap:      %7d bytes\n", ESP.getHeapSize());
  Serial.printf("Free Heap:       %7d bytes\n", ESP.getFreeHeap());
  Serial.printf("Used Heap:       %7d bytes\n", ESP.getHeapSize() - ESP.getFreeHeap());
  Serial.println("----------------------------------------");

  // 内部RAM詳細
  uint32_t internalTotal = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
  uint32_t internalFree = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  uint32_t internalUsed = internalTotal - internalFree;
  Serial.printf("Internal RAM Total: %7d bytes\n", internalTotal);
  Serial.printf("Internal RAM Free:  %7d bytes\n", internalFree);
  Serial.printf("Internal RAM Used:  %7d bytes (%.1f%%)\n",
                internalUsed, (float)internalUsed / internalTotal * 100);
  Serial.println("----------------------------------------");

  // PSRAM詳細
  uint32_t psramTotal = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
  uint32_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  uint32_t psramUsed = psramTotal - psramFree;
  Serial.printf("PSRAM Total:        %7d bytes\n", psramTotal);
  Serial.printf("PSRAM Free:         %7d bytes\n", psramFree);
  Serial.printf("PSRAM Used:         %7d bytes (%.1f%%)\n",
                psramUsed, (float)psramUsed / psramTotal * 100);
  Serial.println("========================================\n");
}
#endif

// ==== LED制御関数（単色LED）====
void setLEDMode(LEDMode mode) {
  if (currentLEDMode == mode) return;
  currentLEDMode = mode;
  lastLEDUpdate = millis();
  breathingValue = 0;
  breathingUp = true;
  blinkState = false;

  // 即座に状態を反映
  switch (mode) {
    case LED_OFF:
      ledcWrite(PIN_LED, 0);    // 0=OFF (GPIO LOW)
      break;
    case LED_ON:
      ledcWrite(PIN_LED, 16);
      break;
    case LED_BREATHING:
      breathingValue = 3;
      ledcWrite(PIN_LED, breathingValue);
      break;
    case LED_BLINKING:
      blinkState = true;
      ledcWrite(PIN_LED, 16);
      break;
  }
}

// loop()から呼ぶLED更新
void updateLEDAnimation() {
  unsigned long now = millis();

  if (currentLEDMode == LED_BREATHING) {
    // ふわふわ: 30ms毎に明るさ変更
    if (now - lastLEDUpdate > 30) {
      lastLEDUpdate = now;

      if (breathingUp) {
        breathingValue += 5;
        if (breathingValue >= 16) {
          breathingValue = 16;
          breathingUp = false;
        }
      } else {
        breathingValue -= 5;
        if (breathingValue <= 3) {  // 完全に消さず、3で折り返し
          breathingValue = 3;
          breathingUp = true;
        }
      }

      ledcWrite(PIN_LED, breathingValue);  // PWM値そのまま
    }
  }
  else if (currentLEDMode == LED_BLINKING) {
    // 点滅: 300ms毎にON/OFF
    if (now - lastLEDUpdate > 300) {
      lastLEDUpdate = now;
      blinkState = !blinkState;
      ledcWrite(PIN_LED, blinkState ? 16 : 0);
    }
  }
}

// ==== 会話履歴に追加 ====
void addToHistory(const String& role, const String& content) {
  if (historyCount >= MAX_HISTORY * 2) {
    for (int i = 0; i < historyCount - 2; i++) {
      conversationHistory[i] = conversationHistory[i + 2];
    }
    historyCount -= 2;
  }

  conversationHistory[historyCount].role = role;
  conversationHistory[historyCount].content = content;
  historyCount++;

  Serial.printf("💾 Added to history [%s]: %s\n", role.c_str(), content.c_str());
}

// ==== mono → stereo 変換（音量調整付き） ====
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  for (size_t i = 0; i < samples; i++) {
    int16_t sample = (int16_t)(mono[i] * VOLUME);
    stereo[2*i]     = sample;
    stereo[2*i + 1] = sample;
  }
}

// ==== I2S 録音設定 (STT) ====
void setupI2SRecord() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE_STT,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = true,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_DATA
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ i2s_driver_install failed: %d\n", err);
  }
  err = i2s_set_pin(I2S_NUM_0, &pins);
  if (err != ESP_OK) {
    Serial.printf("❌ i2s_set_pin failed: %d\n", err);
  }
  i2s_start(I2S_NUM_0);
}

// ==== I2S 再生設定 (TTS) ====
void setupI2SPlay() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  delay(10);

  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE_TTS,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = 32,
    .dma_buf_len = 1024,
    .use_apll = true,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_WS,
    .data_out_num = PIN_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_set_clk(I2S_NUM_1, SAMPLE_RATE_TTS, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
}

// ==== チャンク管理用グローバル変数 ====
static int g_currentChunkSize = -1;
static int g_bytesReadFromChunk = 0;

// ==== HTTPチャンクサイズ読み取り ====
int readChunkSize(WiFiClientSecure& client) {
  const int MAX_RETRIES = 3;

  for (int retry = 0; retry < MAX_RETRIES; retry++) {
    String line = "";
    unsigned long startTime = millis();

    while (client.connected() && (millis() - startTime < 5000)) {
      if (client.available()) {
        char c = client.read();
        if (c == '\n') {
          break;
        } else if (c != '\r') {
          line += c;
        }
      } else {
        delay(1);
      }
    }

    if (line.length() == 0) {
      Serial.printf("[CHUNK] Read empty line (retry %d/%d)\n", retry + 1, MAX_RETRIES);
      if (retry < MAX_RETRIES - 1) {
        delay(100);
        continue;
      }
      return -1;
    }

    int chunkSize = 0;
    bool validHex = false;
    for (int i = 0; i < line.length(); i++) {
      char c = line.charAt(i);
      if (c >= '0' && c <= '9') {
        chunkSize = chunkSize * 16 + (c - '0');
        validHex = true;
      } else if (c >= 'a' && c <= 'f') {
        chunkSize = chunkSize * 16 + (c - 'a' + 10);
        validHex = true;
      } else if (c >= 'A' && c <= 'F') {
        chunkSize = chunkSize * 16 + (c - 'A' + 10);
        validHex = true;
      } else {
        break;
      }
    }

    if (!validHex) {
      Serial.printf("[CHUNK] Invalid hex line: '%s' (retry %d/%d)\n", line.c_str(), retry + 1, MAX_RETRIES);
      if (retry < MAX_RETRIES - 1) {
        delay(100);
        continue;
      }
      return -1;
    }

    Serial.printf("[CHUNK] Size: %d (0x%s)\n", chunkSize, line.c_str());
    return chunkSize;
  }

  return -1;
}

// ==== チャンク境界を超えてデータを読む ====
size_t readBytesAcrossChunks(WiFiClientSecure& client, uint8_t* buffer, size_t length) {
  size_t totalRead = 0;
  unsigned long startTime = millis();
  const unsigned long TIMEOUT_MS = 10000;

  while (totalRead < length) {
    if (millis() - startTime > TIMEOUT_MS) {
      Serial.printf("[READ] Timeout after %d bytes\n", totalRead);
      return totalRead;
    }

    if (g_currentChunkSize == -1 || g_bytesReadFromChunk >= g_currentChunkSize) {
      if (g_currentChunkSize > 0) {
        while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) {
          delay(1);
        }
        client.read();
        client.read();
      }

      g_currentChunkSize = readChunkSize(client);
      g_bytesReadFromChunk = 0;

      if (g_currentChunkSize == 0) {
        return totalRead;
      } else if (g_currentChunkSize < 0) {
        Serial.println("[READ] Chunk read error");
        return totalRead;
      }
    }

    int remainingInChunk = g_currentChunkSize - g_bytesReadFromChunk;
    int toRead = min((int)(length - totalRead), remainingInChunk);

    while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) {
      delay(1);
    }

    if (!client.connected() && !client.available()) {
      Serial.println("[READ] Connection closed");
      return totalRead;
    }

    int available = client.available();
    if (available > 0) {
      int actualRead = min(toRead, available);
      size_t read = client.readBytes(buffer + totalRead, actualRead);
      totalRead += read;
      g_bytesReadFromChunk += read;
    }
  }

  return totalRead;
}

// ==== バイナリプロトコル: メタデータ処理 (type=0x01) ====
void processMetadata(WiFiClientSecure& client, uint32_t length) {
  if (length == 0 || length > 4096) {
    Serial.printf("[META] Invalid length: %d\n", length);
    return;
  }

  char* jsonBuf = (char*)malloc(length + 1);
  if (!jsonBuf) {
    Serial.println("[META] malloc failed");
    return;
  }

  size_t bytesRead = readBytesAcrossChunks(client, (uint8_t*)jsonBuf, length);
  jsonBuf[bytesRead] = '\0';

  if (bytesRead != length) {
    Serial.printf("[META] Read mismatch: expected=%d, got=%d\n", length, bytesRead);
    free(jsonBuf);
    return;
  }

  String json = String(jsonBuf);
  Serial.printf("[META] %s\n", jsonBuf);

  if (json.indexOf("\"event\":\"segment\"") >= 0) {
    int p = json.indexOf("\"text\":\"");
    if (p >= 0) {
      p += 8;
      int e = json.indexOf("\"", p);
      if (e >= 0) {
        String segmentText = json.substring(p, e);
        responseText += segmentText;
        Serial.printf("[SEGMENT] Text: %s\n", segmentText.c_str());
      }
    }
    int idPos = json.indexOf("\"id\":");
    if (idPos >= 0) {
      idPos += 5;
      curSegmentId = json.substring(idPos, json.indexOf(",", idPos)).toInt();
    }
  }

  if (json.indexOf("\"event\":\"tts_start\"") >= 0) {
    int sizePos = json.indexOf("\"size\":");
    if (sizePos >= 0) {
      sizePos += 7;
      currentPcmSize = json.substring(sizePos, json.indexOf("}", sizePos)).toInt();
      Serial.printf("[TTS_START] id=%d, size=%d\n", curSegmentId, currentPcmSize);
    }
  }

  free(jsonBuf);
}

// ==== バイナリプロトコル: PCMデータ処理 (type=0x02) - ストリーミング版 ====
void processPCM(WiFiClientSecure& client, uint32_t length) {
  // アンプをPWMでゆっくりON（突入電流抑制）
  if (!ampOn) {
    ledcAttach(PIN_AMP_SD, 1000, 8);
    for (int i = 0; i <= 255; i += 5) {
      ledcWrite(PIN_AMP_SD, i);
      delay(2);
    }
    ledcDetach(PIN_AMP_SD);
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
  }
  Serial.printf("[PCM] Streaming %d bytes\n", length);
#if DEBUG_MEMORY
  printMemoryStatus("Before PCM Processing");
#endif

  // ストリーミング再生用のバッファ（64KB）
  const size_t STREAM_CHUNK_SIZE = 65536;
  uint32_t remaining = length;
  uint32_t totalPlayed = 0;

  while (remaining > 0) {
    updateLEDAnimation();

    uint32_t chunkSize = (remaining > STREAM_CHUNK_SIZE) ? STREAM_CHUNK_SIZE : remaining;

    uint8_t* pcmData = (uint8_t*)ps_malloc(chunkSize);
    if (!pcmData) {
      pcmData = (uint8_t*)malloc(chunkSize);
    }
    if (!pcmData) {
      Serial.printf("[PCM] malloc failed for chunk! Skipping remaining %d bytes\n", remaining);
      uint8_t dummy[512];
      while (remaining > 0) {
        uint32_t toRead = (remaining > 512) ? 512 : remaining;
        size_t read = readBytesAcrossChunks(client, dummy, toRead);
        if (read == 0) break;
        remaining -= read;
      }
      return;
    }

    size_t bytesRead = readBytesAcrossChunks(client, pcmData, chunkSize);
    if (bytesRead != chunkSize) {
      Serial.printf("[PCM] Read mismatch in chunk: expected=%d, got=%d\n", chunkSize, bytesRead);
      free(pcmData);
      break;
    }

    size_t samples = bytesRead / 2;
    size_t stereoBytes = samples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
    if (!stereo) {
      Serial.println("[PCM] stereo malloc failed for chunk!");
      free(pcmData);
      break;
    }

    monoToStereo((int16_t*)pcmData, stereo, samples);
    free(pcmData);

    size_t written = 0;
    i2s_write(I2S_NUM_1, (uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
    free(stereo);

    totalPlayed += written;
    remaining -= bytesRead;

    if (totalPlayed % (STREAM_CHUNK_SIZE * 4) == 0) {
      Serial.printf("[PCM] Streaming... played %d/%d bytes\n", totalPlayed, length * 2);
    }
  }

  Serial.printf("[PCM] Streaming complete: %d bytes total\n", totalPlayed);
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";

  // 処理中状態は省略（LED更新を最小化）
  // setLEDState(LED_PROCESSING);

  if (isRecording) {
    ws.disconnect();
    isRecording = false;
    Serial.println("🛑 Stopped recording for TTS");
  }

  i2s_driver_uninstall(I2S_NUM_0);
  setupI2SPlay();

  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    setLEDMode(LED_OFF);  // エラー時は消灯
    return;
  }

  String messagesJson = "[";
  for (int i = 0; i < historyCount; i++) {
    if (i > 0) messagesJson += ",";
    messagesJson += "{\"role\":\"" + conversationHistory[i].role + "\",";
    messagesJson += "\"content\":\"" + conversationHistory[i].content + "\"}";
  }
  if (historyCount > 0) messagesJson += ",";
  messagesJson += "{\"role\":\"user\",\"content\":\"" + text + "\"}";
  messagesJson += "]";

  String payload =
    "{\"model\":\"" + String(TTS_PROVIDER) + "\",\"voice\":\"" + String(TTS_CHARACTER) + "\","
    "\"device_id\":\"" + deviceMacAddress + "\","
    "\"session_id\":\"" + sessionId + "\","
    "\"owner_id\":\"" + deviceMacAddress + "\","
    "\"messages\":" + messagesJson + "}";

  Serial.printf("📝 History count: %d\n", historyCount);

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  client.print(req);

  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.println("📨 BINARY STREAM START (Chunked)");

  g_currentChunkSize = -1;
  g_bytesReadFromChunk = 0;

  // TTS開始 = 再生中はLED点滅
  setLEDMode(LED_BLINKING);

  while (client.connected() || client.available()) {
    uint8_t header[5];
    size_t read = readBytesAcrossChunks(client, header, 5);

    if (read == 0) {
      Serial.println("🏁 BINARY STREAM END");
      break;
    }

    if (read != 5) {
      Serial.printf("[BINARY] Header incomplete: %d/5 bytes\n", read);
      break;
    }

    uint8_t type = header[0];
    uint32_t length = (header[1]) | (header[2] << 8) | (header[3] << 16) | (header[4] << 24);

    Serial.printf("[BINARY] type=0x%02X, length=%d\n", type, length);

    if (type == 0x01) {
      processMetadata(client, length);
    } else if (type == 0x02) {
      processPCM(client, length);
    } else {
      Serial.printf("[BINARY] Unknown type: 0x%02X, skip %d bytes\n", type, length);
      uint8_t* dummy = (uint8_t*)malloc(length);
      if (dummy) {
        readBytesAcrossChunks(client, dummy, length);
        free(dummy);
      }
    }
  }

  Serial.println("🔊 Playback complete");

  // アンプOFF＋次回ソフトスタートのためフラグリセット
  digitalWrite(PIN_AMP_SD, LOW);
  ampOn = false;

  delay(1500);
  Serial.println("🔊 Buffer flushed");

  addToHistory("user", text);
  if (responseText.length() > 0) {
    addToHistory("assistant", responseText);
  }

  i2s_stop(I2S_NUM_1);
  i2s_driver_uninstall(I2S_NUM_1);

  startSTTRecording();
}

// ==== Soniox WebSocketイベント ====
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ Connected to Soniox!");
      {
        String startMsg =
          "{\"api_key\":\"" + sonioxKey + "\","
          "\"model\":\"stt-rt-v3\","
          "\"audio_format\":\"pcm_s16le\","
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox");
        // 録音開始 = LEDふわふわ
        setLEDMode(LED_BREATHING);
      }
      isRecording = true;
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;
      if (msg.indexOf("\"tokens\"") >= 0) {
        String newText = "";
        bool foundEndToken = false;
        int pos = 0;
        while ((pos = msg.indexOf("\"text\":\"", pos)) >= 0) {
          pos += 8;
          int end = msg.indexOf("\"", pos);
          if (end < 0) break;
          String token = msg.substring(pos, end);
          if (token == "\\u003cend\\u003e") {
            foundEndToken = true;  // <end>トークン検出
          } else {
            newText += token;
          }
        }

        if (newText.length() > 0) {
          if (newText.startsWith(partialText)) {
            partialText = newText;
          } else {
            partialText = newText;
          }
          lastPartialMs = millis();
          armed = true;
          Serial.println("📝 " + partialText);
        }

        // <end>トークン検出時、即座に確定
        if (foundEndToken && partialText.length() > 0) {
          Serial.println("🎯 Endpoint detected by Soniox!");
          endpointDetected = true;
        }
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("✅ Soniox disconnected");
      isRecording = false;
      break;

    case WStype_BIN:
    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;
  }
}

// ==== STT録音開始 ====
void startSTTRecording() {
  Serial.println("🎙️ Starting STT recording...");

  // 録音準備中はLED点灯（WebSocket接続後にふわふわに変わる）
  setLEDMode(LED_ON);

  setupI2SRecord();

  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);

  partialText = "";
  lastFinalText = "";
  armed = false;
  endpointDetected = false;
}

// ==== WiFi接続（1回試行）- Country=JP対応 ====
bool tryConnectWiFiOnce(const String& ssid, const String& password) {
  wifiConnected = false;
  wifiGotIP = false;

  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);

  // iPhoneホットスポット対応: Country=JP設定
  wifi_country_t country = {
    .cc = "JP",
    .schan = 1,
    .nchan = 14,
    .max_tx_power = 20,
    .policy = WIFI_COUNTRY_POLICY_MANUAL
  };
  esp_wifi_set_country(&country);

  Serial.printf("📶 Connecting to: %s\n", ssid.c_str());
  WiFi.begin(ssid.c_str(), password.c_str());

  // 最大10秒待機
  for (int i = 0; i < 10; i++) {
    delay(1000);
    Serial.print(".");
    if (wifiGotIP) {
      return true;
    }
  }

  return false;
}

// ==== BLEからのWiFi接続試行 ====
void tryConnectWiFiFromBLE(const String& ssid, const String& password) {
  Serial.printf("📶 Connecting to WiFi from BLE: %s\n", ssid.c_str());
  sendBLEStatus("CONNECTING");

  const int MAX_RETRIES = 5;
  for (int retry = 1; retry <= MAX_RETRIES; retry++) {
    Serial.printf("\n🔄 Attempt %d of %d\n", retry, MAX_RETRIES);

    if (tryConnectWiFiOnce(ssid, password)) {
      Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

      // NVSに保存
      saveWiFiCredentials(ssid, password);
      wifiSSID = ssid;
      wifiPassword = password;

      // BLE MACをNVSに保存（以降の起動でdevice_idとして使用）
      deviceMacAddress = BLEDevice::getAddress().toString().c_str();
      saveDeviceMac(deviceMacAddress);

      sendBLEStatus("CONNECTED");

      // NVS保存済みなので再起動して通常モードへ（BLE deinitの詰まり回避）
      delay(1000);
      ESP.restart();
      return;
    }

    Serial.printf("\n❌ Attempt %d failed\n", retry);

    if (retry < MAX_RETRIES) {
      Serial.println("⏳ Waiting 2 seconds before retry...");
      delay(2000);
    }
  }

  Serial.println("\n❌ WiFi connection failed after all retries");
  sendBLEStatus("FAILED");
}

// ==== 通常動作開始（Soniox初期化〜STT録音） ====
void startNormalOperation() {
  Serial.println("🎯 Starting normal operation...");
  currentMode = MODE_NORMAL;

  // Soniox temp key取得
  HTTPClient http;
  http.begin(SONIOX_LAMBDA_URL);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("❌ HTTP fail %d\n", code);
    setLEDMode(LED_OFF);
    return;
  }
  String resp = http.getString();
  http.end();

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    Serial.println("⚠️ JSON parse error");
    setLEDMode(LED_OFF);
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key obtained");

#if DEBUG_MEMORY
  printMemoryStatus("After WiFi & Soniox Init");
#endif

  // STT録音開始（再生設定はsendToLambdaAndPlay()内で行う）
  startSTTRecording();
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(100);
  Serial.println("\n🚀 ToyTalk Conversation v2.0 (BLE WiFi Provisioning)");

  // WiFiイベントハンドラ登録
  WiFi.onEvent(WiFiEvent);

  // LED初期化（PWM使用 - 新API）
  ledcAttach(PIN_LED, LED_FREQ, LED_RESOLUTION);
  setLEDMode(LED_ON);  // 起動中は点灯

  // NVSからBLE MACアドレスを読み込み（WiFi設定時に保存済みの場合）
  deviceMacAddress = loadDeviceMac();
  if (deviceMacAddress.length() > 0) {
    Serial.printf("📱 Device MAC (from NVS): %s\n", deviceMacAddress.c_str());
  }

  // ボタン初期化
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  // NVSからWiFi設定読み込み
  if (loadWiFiCredentials()) {
    // 設定あり → 接続試行
    Serial.printf("📶 Connecting to WiFi: %s\n", wifiSSID.c_str());

    const int MAX_RETRIES = 5;
    bool connected = false;

    for (int retry = 1; retry <= MAX_RETRIES; retry++) {
      Serial.printf("\n🔄 Attempt %d of %d\n", retry, MAX_RETRIES);

      if (tryConnectWiFiOnce(wifiSSID, wifiPassword)) {
        connected = true;
        break;
      }

      Serial.printf("\n❌ Attempt %d failed\n", retry);

      if (retry < MAX_RETRIES) {
        Serial.println("⏳ Waiting 2 seconds before retry...");
        delay(2000);
      }
    }

    if (connected) {
      Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
      // セッションID生成（電源ON単位）
      sessionId = String(millis()) + "-" + String(random(100000, 999999));
      Serial.printf("🆔 Session ID: %s\n", sessionId.c_str());
      startNormalOperation();
    } else {
      Serial.println("\n❌ WiFi connection failed, entering BLE provisioning mode");
      startBLE();
    }
  } else {
    // 設定なし → BLEモード
    Serial.println("⚠️ No WiFi config, entering BLE provisioning mode");
    startBLE();
  }
}

// ==== ボタン長押し処理 ====
void handleButtonLongPress() {
  bool pressed = (digitalRead(PIN_BUTTON) == LOW);

  if (pressed && !buttonLongPressTriggered) {
    if (buttonPressStart == 0) {
      buttonPressStart = millis();
    } else if (millis() - buttonPressStart >= LONG_PRESS_MS) {
      // 長押し検出
      buttonLongPressTriggered = true;
      if (currentMode == MODE_NORMAL) {
        Serial.println("🔘 Long press detected - Entering BLE mode");
        // 録音停止
        if (isRecording) {
          ws.disconnect();
          isRecording = false;
        }
        WiFi.disconnect(true);
        startBLE();
      }
    }
  } else if (!pressed) {
    buttonPressStart = 0;
    buttonLongPressTriggered = false;
  }
}

// ==== LOOP ====
void loop() {
  // ===== BLEモード処理 =====
  if (currentMode == MODE_BLE_PROV) {
    updateLEDAnimation();
    handleButtonLongPress();

    // BLE接続状態変化処理
    if (!bleDeviceConnected && oldBleDeviceConnected) {
      delay(500);
      if (pServer) {
        pServer->startAdvertising();
      }
    }
    oldBleDeviceConnected = bleDeviceConnected;

    delay(10);
    return;  // 会話処理はスキップ
  }

  // ===== 通常モード: 会話処理 =====
  ws.loop();

  // LED演出更新
  updateLEDAnimation();

  // ボタン長押しチェック
  handleButtonLongPress();

  // ボタンチェック（デバウンス処理付き）- 短押し用
  int reading = digitalRead(PIN_BUTTON);

  // 読み取り値が変化したらデバウンスタイマーをリセット
  if (reading != lastButtonReading) {
    lastDebounceTime = millis();
  }

  // デバウンス時間経過後、安定した状態を確定
  if ((millis() - lastDebounceTime) > debounceDelay) {
    // 状態が変化した場合のみ処理
    if (reading != buttonState) {
      buttonState = reading;

      // HIGHからLOWへの遷移（ボタン押下）のみ検知
      if (buttonState == LOW) {
        Serial.println("🔘 Button pressed");
        // ここに将来の拡張処理を追加
      }
    }
  }

  lastButtonReading = reading;

  // 録音データをWebSocketに送信
  if (isRecording && wifiGotIP && ws.isConnected()) {
    static uint32_t lastSend = 0;
    if (millis() - lastSend > 5) {
      int32_t raw[512];
      int16_t pcm[512];
      size_t n = 0;
      i2s_read(I2S_NUM_0, (void*)raw, sizeof(raw), &n, portMAX_DELAY);
      int samples = n / sizeof(int32_t);
      for (int i = 0; i < samples; i++) {
        pcm[i] = (int16_t)(raw[i] >> 14);
      }
      ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      lastSend = millis();
    }
  }

  // Sonioxエンドポイント検出 → 即座に確定（優先）
  if (endpointDetected && partialText.length() > 0) {
    if (partialText != lastFinalText) {
      Serial.println("\n✅ 確定文（エンドポイント検出）:");
      Serial.println(partialText);
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    endpointDetected = false;
    armed = false;
    partialText = "";
  }
  // 無音検出 → 確定文出力（フォールバック）
  else if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
    if (partialText != lastFinalText) {
      Serial.println("\n✅ 確定文（無音検出）:");
      Serial.println(partialText);
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    armed = false;
    partialText = "";
  }
}
