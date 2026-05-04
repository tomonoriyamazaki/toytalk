// toytalker_mini_v0.3
// v0.2ベース、LED PWM排除（I2S録音品質への干渉回避）
// LED制御はすべてdigitalWrite

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
#define DEBUG_MEMORY 0

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
  MODE_NORMAL,
  MODE_BLE_PROV,
  MODE_CONNECTING
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

// ==== Lambda (Backchannel) ====
const char* BACKCHANNEL_HOST = "birb7yjw4nkldidcza4xfiyn5e0taluh.lambda-url.ap-northeast-1.on.aws";
const char* BACKCHANNEL_PATH = "/";

// ==== Lambda (Soniox Key) ====
const char* SONIOX_LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;
String sonioxModel = "stt-rt-v4";

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

// LED状態（PWMなし、digitalWriteのみ）
enum LEDMode {
  LED_OFF,
  LED_ON,
  LED_BLINKING
};

volatile LEDMode currentLEDMode = LED_OFF;
volatile bool blinkState = false;
hw_timer_t* ledTimer = NULL;
bool ampOn = false;
volatile bool bargeInRequested = false;

void IRAM_ATTR onBargeInButton() {
  bargeInRequested = true;
}

// ボタン状態
int lastButtonReading = HIGH;
int buttonState = HIGH;
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

unsigned long buttonPressStart = 0;
bool buttonLongPressTriggered = false;
const unsigned long LONG_PRESS_MS = 3000;

// ==== WiFi接続状態（イベントベース） ====
volatile bool wifiConnected = false;
volatile bool wifiGotIP = false;

// ==== Soniox STT 状態 ====
WebSocketsClient ws;
String partialText = "";
String sonioxFinalBuf = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;
bool isRecording = false;
bool endpointDetected = false;

// ==== TTS 受信状態 ====
int curSegmentId = -1;
String responseText = "";
uint8_t* currentPcmBuffer = NULL;
size_t currentPcmSize = 0;

// ==== 相槌（Backchannel）状態 ====
bool backchannelEnabled = true;
const int BACKCHANNEL_TRIGGER_CHARS = 10;

int utf8Len(const String& s) {
  int count = 0;
  for (int i = 0; i < s.length(); ) {
    uint8_t c = (uint8_t)s.charAt(i);
    if (c < 0x80) i += 1;
    else if (c < 0xE0) i += 2;
    else if (c < 0xF0) i += 3;
    else i += 4;
    count++;
  }
  return count;
}
volatile bool backchannelFetching = false;
volatile bool backchannelReady = false;
volatile bool backchannelFired = false;
volatile bool backchannelAbort = false;
uint8_t* backchannelPcm = NULL;
size_t backchannelPcmSize = 0;
String backchannelText = "";
TaskHandle_t backchannelTaskHandle = NULL;

const int MAX_PAST_BACKCHANNELS = 10;
String pastBackchannels[MAX_PAST_BACKCHANNELS];
int pastBackchannelCount = 0;

void addPastBackchannel(const String& text) {
  if (pastBackchannelCount >= MAX_PAST_BACKCHANNELS) {
    for (int i = 0; i < pastBackchannelCount - 1; i++) {
      pastBackchannels[i] = pastBackchannels[i + 1];
    }
    pastBackchannelCount--;
  }
  pastBackchannels[pastBackchannelCount] = text;
  pastBackchannelCount++;
}

// ==== セッションID ====
String sessionId = "";

// ==== 会話履歴 ====
const int MAX_HISTORY = 5;
struct Message {
  String role;
  String content;
};
Message conversationHistory[MAX_HISTORY * 2];
int historyCount = 0;

// ==== 音量調整 ====
const float VOLUME = 1.0;

// ==== TTS設定 ====
const char* TTS_PROVIDER = "ElevenLabs";
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
    pendingSSID = pCharacteristic->getValue().c_str();
    Serial.printf("📝 Received SSID: %s\n", pendingSSID.c_str());
  }
};

class PasswordCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    pendingPassword = pCharacteristic->getValue().c_str();
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

  BLECharacteristic* pSSIDChar = pService->createCharacteristic(CHAR_SSID_UUID, BLECharacteristic::PROPERTY_WRITE);
  pSSIDChar->setCallbacks(new SSIDCallbacks());

  BLECharacteristic* pPasswordChar = pService->createCharacteristic(CHAR_PASSWORD_UUID, BLECharacteristic::PROPERTY_WRITE);
  pPasswordChar->setCallbacks(new PasswordCallbacks());

  BLECharacteristic* pCommandChar = pService->createCharacteristic(CHAR_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  pCommandChar->setCallbacks(new CommandCallbacks());

  pStatusChar = pService->createCharacteristic(
    CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pStatusChar->addDescriptor(new BLE2902());
  pStatusChar->setValue("READY");

  BLECharacteristic* pMacChar = pService->createCharacteristic(CHAR_MAC_UUID, BLECharacteristic::PROPERTY_READ);
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
  setLEDMode(LED_BLINKING);
}

// ==== BLE停止 ====
void stopBLE() {
  Serial.println("🔵 Stopping BLE...");
  BLEDevice::deinit(true);
  pServer = NULL;
  pStatusChar = NULL;
  bleDeviceConnected = false;
}

// ==== LED タイマー割り込み（3ms周期、digitalWriteで擬似PWM）====
void IRAM_ATTR onLEDTimer() {
  static uint8_t cycle = 0;
  cycle = (cycle + 1) % 10;  // 0-9の10段階、3ms*10=30ms周期

  LEDMode mode = currentLEDMode;
  if (mode == LED_OFF) {
    if (cycle == 0) digitalWrite(PIN_LED, LOW);
  } else if (mode == LED_ON) {
    // 10%デューティ（1/10だけON）
    digitalWrite(PIN_LED, (cycle == 0) ? HIGH : LOW);
  } else if (mode == LED_BLINKING) {
    static uint8_t blinkCounter = 0;
    if (cycle == 0) blinkCounter++;
    if (blinkCounter >= 10) {  // 30ms*10=300ms周期
      blinkCounter = 0;
      blinkState = !blinkState;
    }
    // 点灯中は10%デューティ
    digitalWrite(PIN_LED, (blinkState && cycle == 0) ? HIGH : LOW);
  }
}

// ==== LED制御関数（digitalWriteのみ）====
void setLEDMode(LEDMode mode) {
  if (currentLEDMode == mode) return;
  currentLEDMode = mode;
  blinkState = false;

  switch (mode) {
    case LED_OFF:
      digitalWrite(PIN_LED, LOW);
      break;
    case LED_ON:
      digitalWrite(PIN_LED, HIGH);
      break;
    case LED_BLINKING:
      blinkState = true;
      digitalWrite(PIN_LED, HIGH);
      break;
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

// ==== mono → stereo 変換 ====
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

  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
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
    .dma_buf_count = 8,
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
        if (c == '\n') break;
        else if (c != '\r') line += c;
      } else {
        delay(1);
      }
    }
    if (line.length() == 0) {
      if (retry < MAX_RETRIES - 1) { delay(100); continue; }
      return -1;
    }
    int chunkSize = 0;
    bool validHex = false;
    for (int i = 0; i < line.length(); i++) {
      char c = line.charAt(i);
      if (c >= '0' && c <= '9') { chunkSize = chunkSize * 16 + (c - '0'); validHex = true; }
      else if (c >= 'a' && c <= 'f') { chunkSize = chunkSize * 16 + (c - 'a' + 10); validHex = true; }
      else if (c >= 'A' && c <= 'F') { chunkSize = chunkSize * 16 + (c - 'A' + 10); validHex = true; }
      else break;
    }
    if (!validHex) {
      if (retry < MAX_RETRIES - 1) { delay(100); continue; }
      return -1;
    }
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
    if (millis() - startTime > TIMEOUT_MS) return totalRead;

    if (g_currentChunkSize == -1 || g_bytesReadFromChunk >= g_currentChunkSize) {
      if (g_currentChunkSize > 0) {
        while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) delay(1);
        client.read();
        client.read();
      }
      g_currentChunkSize = readChunkSize(client);
      g_bytesReadFromChunk = 0;
      if (g_currentChunkSize == 0) return totalRead;
      else if (g_currentChunkSize < 0) return totalRead;
    }

    int remainingInChunk = g_currentChunkSize - g_bytesReadFromChunk;
    int toRead = min((int)(length - totalRead), remainingInChunk);

    while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) delay(1);
    if (!client.connected() && !client.available()) return totalRead;

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

// ==== メタデータ処理 (type=0x01) ====
void processMetadata(WiFiClientSecure& client, uint32_t length) {
  if (length == 0 || length > 4096) return;

  char* jsonBuf = (char*)malloc(length + 1);
  if (!jsonBuf) return;

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

// ==== PCMデータ処理 (type=0x02) ====
bool processPCM(WiFiClientSecure& client, uint32_t length) {
  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
  }
  Serial.printf("[PCM] Streaming %d bytes\n", length);

  const size_t STREAM_CHUNK_SIZE = 65536;
  uint32_t remaining = length;
  uint32_t totalPlayed = 0;

  while (remaining > 0) {
    if (bargeInRequested) {
      Serial.println("🔘 Barge-in! Stopping playback");
      return true;
    }

    uint32_t chunkSize = (remaining > STREAM_CHUNK_SIZE) ? STREAM_CHUNK_SIZE : remaining;

    uint8_t* pcmData = (uint8_t*)ps_malloc(chunkSize);
    if (!pcmData) pcmData = (uint8_t*)malloc(chunkSize);
    if (!pcmData) {
      Serial.printf("[PCM] malloc failed for chunk! Skipping remaining %d bytes\n", remaining);
      uint8_t dummy[512];
      while (remaining > 0) {
        uint32_t toRead = (remaining > 512) ? 512 : remaining;
        size_t read = readBytesAcrossChunks(client, dummy, toRead);
        if (read == 0) break;
        remaining -= read;
      }
      return false;
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
  }

  Serial.printf("[PCM] Streaming complete: %d bytes total\n", totalPlayed);
  return false;
}

// ==== 相槌キャッシュクリア ====
void clearBackchannelCache() {
  if (backchannelPcm) { free(backchannelPcm); backchannelPcm = NULL; }
  backchannelPcmSize = 0;
  backchannelText = "";
  backchannelReady = false;
  backchannelFetching = false;
  backchannelFired = false;
  backchannelAbort = false;
}

// ==== 相槌フェッチ用FreeRTOSタスク ====
struct BackchannelParams {
  String partialText;
  String characterId;
};

void fetchBackchannelTask(void* param) {
  BackchannelParams* p = (BackchannelParams*)param;
  String partial = p->partialText;
  String charId = p->characterId;
  delete p;

  Serial.printf("[BC] Fetching backchannel for: %s\n", partial.c_str());
  Serial.printf("[BC] Free heap before: %d\n", ESP.getFreeHeap());

  String url = String("https://") + BACKCHANNEL_HOST + BACKCHANNEL_PATH;
  String payload = "{\"partial_text\":\"" + partial + "\"";
  if (charId.length() > 0) {
    payload += ",\"device_id\":\"" + charId + "\"";
  }
  if (historyCount > 0) {
    payload += ",\"history\":[";
    int start = (historyCount > 6) ? historyCount - 6 : 0;
    for (int i = start; i < historyCount; i++) {
      if (i > start) payload += ",";
      payload += "{\"role\":\"" + conversationHistory[i].role + "\",\"content\":\"" + conversationHistory[i].content + "\"}";
    }
    payload += "]";
  }
  if (pastBackchannelCount > 0) {
    payload += ",\"past_backchannels\":[";
    for (int i = 0; i < pastBackchannelCount; i++) {
      if (i > 0) payload += ",";
      payload += "\"" + pastBackchannels[i] + "\"";
    }
    payload += "]";
  }
  payload += "}";

  {
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);
    const char* headerKeys[] = {"X-Backchannel-Text", "x-backchannel-text"};
    http.collectHeaders(headerKeys, 2);

    int httpCode = http.POST(payload);

    if (backchannelAbort || httpCode != 200) {
      Serial.printf("[BC] %s (code=%d)\n", backchannelAbort ? "Aborted" : "HTTP error", httpCode);
      http.end();
    } else {
      if (http.hasHeader("X-Backchannel-Text")) {
        backchannelText = http.header("X-Backchannel-Text");
      } else if (http.hasHeader("x-backchannel-text")) {
        backchannelText = http.header("x-backchannel-text");
      }

      int len = http.getSize();
      WiFiClient* stream = http.getStreamPtr();

      const size_t INIT_SIZE = 32768;
      const size_t MAX_SIZE = 256000;
      size_t bufSize = (len > 0) ? (size_t)len : INIT_SIZE;
      uint8_t* pcm = (uint8_t*)ps_malloc(bufSize);
      if (!pcm) pcm = (uint8_t*)malloc(bufSize);

      if (pcm) {
        size_t totalRead = 0;
        unsigned long startTime = millis();
        while (http.connected() && (millis() - startTime < 15000) && !backchannelAbort) {
          size_t avail = stream->available();
          if (avail > 0) {
            if (totalRead + avail > bufSize) {
              size_t newSize = min(bufSize * 2, MAX_SIZE);
              if (newSize <= bufSize) break;
              uint8_t* newBuf = (uint8_t*)ps_realloc(pcm, newSize);
              if (!newBuf) newBuf = (uint8_t*)realloc(pcm, newSize);
              if (!newBuf) break;
              pcm = newBuf;
              bufSize = newSize;
            }
            size_t rd = stream->readBytes(pcm + totalRead, avail);
            totalRead += rd;
          } else {
            if (len > 0 && (int)totalRead >= len) break;
            delay(1);
          }
        }

        if (totalRead > 0 && !backchannelAbort) {
          backchannelPcm = pcm;
          backchannelPcmSize = totalRead;
          backchannelReady = true;
          Serial.printf("[BC] Ready: pcm=%d bytes\n", totalRead);
        } else {
          free(pcm);
          Serial.printf("[BC] %s\n", backchannelAbort ? "Aborted" : "No PCM data");
        }
      } else {
        Serial.println("[BC] malloc failed");
      }
      http.end();
    }
  }

  Serial.printf("[BC] Free heap after: %d\n", ESP.getFreeHeap());
  backchannelFetching = false;
  backchannelTaskHandle = NULL;
  vTaskDelete(NULL);
}

// ==== 相槌フェッチ開始 ====
void startBackchannelFetch(const String& partial) {
  if (!backchannelEnabled) return;
  if (backchannelFetching || backchannelReady || backchannelFired) return;
  if (strlen(BACKCHANNEL_HOST) == 0) return;
  if (ESP.getFreeHeap() < 60000) {
    Serial.printf("[BC] Not enough heap: %d bytes, skipping\n", ESP.getFreeHeap());
    return;
  }

  backchannelFetching = true;

  BackchannelParams* params = new BackchannelParams();
  params->partialText = partial;
  params->characterId = deviceMacAddress;

  xTaskCreatePinnedToCore(fetchBackchannelTask, "bc_fetch", 16384, params, 1, &backchannelTaskHandle, 1);
}

// ==== 相槌再生 ====
bool playBackchannelIfReady() {
  if (!backchannelReady || !backchannelPcm || backchannelPcmSize == 0) return false;

  Serial.printf("[BC] Playing backchannel: %d bytes\n", backchannelPcmSize);

  size_t samples = backchannelPcmSize / 2;
  const size_t PLAY_CHUNK = 4096;
  size_t offset = 0;

  while (offset < samples) {
    size_t chunkSamples = min(PLAY_CHUNK, samples - offset);
    size_t stereoBytes = chunkSamples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
    if (!stereo) break;

    monoToStereo((int16_t*)(backchannelPcm + offset * 2), stereo, chunkSamples);
    size_t written = 0;
    i2s_write(I2S_NUM_1, (uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
    free(stereo);
    offset += chunkSamples;
  }

  backchannelFired = true;
  if (backchannelText.length() > 0) addPastBackchannel(backchannelText);
  Serial.println("[BC] Backchannel playback done");

  free(backchannelPcm);
  backchannelPcm = NULL;
  backchannelPcmSize = 0;
  backchannelReady = false;

  return true;
}

// ---- Lambda SSL接続+リクエスト送信バックグラウンドタスク ----
struct LambdaConnectParams {
  WiFiClientSecure* client;
  String* request;
  volatile bool connected;
  volatile bool sent;
  volatile bool failed;
};

void lambdaConnectAndSendTask(void* param) {
  LambdaConnectParams* p = (LambdaConnectParams*)param;
  p->client->setInsecure();
  if (!p->client->connect(LAMBDA_HOST, 443)) {
    p->failed = true;
    vTaskDelete(NULL);
    return;
  }
  p->connected = true;
  p->client->print(*(p->request));
  p->sent = true;
  vTaskDelete(NULL);
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  unsigned long t0 = millis();
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";

  if (isRecording) isRecording = false;

  // バックチャネルタスク完了待ち
  if (backchannelFetching && backchannelTaskHandle != NULL) {
    Serial.println("[BC] Waiting for backchannel task to finish...");
    unsigned long waitStart = millis();
    while (backchannelTaskHandle != NULL && (millis() - waitStart < 10000)) delay(10);
    if (backchannelTaskHandle != NULL) {
      Serial.println("[BC] Timeout - aborting task");
      backchannelAbort = true;
      unsigned long abortStart = millis();
      while (backchannelTaskHandle != NULL && (millis() - abortStart < 3000)) delay(10);
      backchannelAbort = false;
    }
  }
  Serial.printf("⏱️ [%lums] BC wait done\n", millis() - t0);

  // タイマー再開（再生中のLEDアニメーション用）
  timerAlarm(ledTimer, 3000, true, 0);

  // I2S切り替え
  i2s_driver_uninstall(I2S_NUM_0);
  setupI2SPlay();
  Serial.printf("⏱️ [%lums] I2S switched\n", millis() - t0);

  // Soniox WebSocket切断
  ws.disconnect();
  Serial.printf("⏱️ [%lums] WS disconnected\n", millis() - t0);

  // ペイロード組み立て
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
    "\"backchannel_fired\":" + (backchannelFired ? "true" : "false") + ","
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

  // Lambda SSL接続+送信をCore 0でバックグラウンド
  WiFiClientSecure client;
  LambdaConnectParams connParams = { &client, &req, false, false, false };
  TaskHandle_t connTaskHandle = NULL;
  xTaskCreatePinnedToCore(lambdaConnectAndSendTask, "lambda_conn", 16384, &connParams, 1, &connTaskHandle, 0);
  Serial.printf("⏱️ [%lums] Lambda task started on Core 0\n", millis() - t0);

  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
    Serial.printf("⏱️ [%lums] Amp ready\n", millis() - t0);
  }

  // 相槌再生（Lambda接続と並列）
  if (backchannelReady && backchannelPcm && backchannelPcmSize > 0) {
    Serial.println("[BC] Playing backchannel while Lambda connects...");
    playBackchannelIfReady();
  }
  Serial.printf("⏱️ [%lums] Backchannel phase done\n", millis() - t0);

  // Lambda接続完了待ち
  while (!connParams.sent && !connParams.failed) delay(1);
  Serial.printf("⏱️ [%lums] Lambda request sent (ok=%d)\n", millis() - t0, !connParams.failed);

  if (connParams.failed) {
    Serial.printf("💾 Free heap at failure: %d\n", ESP.getFreeHeap());
    setLEDMode(LED_OFF);
    i2s_stop(I2S_NUM_1);
    i2s_driver_uninstall(I2S_NUM_1);
    if (ampOn) { digitalWrite(PIN_AMP_SD, LOW); ampOn = false; }
    clearBackchannelCache();
    startSTTRecording();
    return;
  }

  // HTTPレスポンスヘッダー読み取り
  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.printf("⏱️ [%lums] Headers read, first audio byte incoming\n", millis() - t0);
  Serial.println("📨 BINARY STREAM START (Chunked)");

  g_currentChunkSize = -1;
  g_bytesReadFromChunk = 0;

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
      if (processPCM(client, length)) {
        Serial.println("🔘 Barge-in: aborting stream");
        client.stop();
        break;
      }
    } else {
      Serial.printf("[BINARY] Unknown type: 0x%02X, skip %d bytes\n", type, length);
      uint8_t* dummy = (uint8_t*)malloc(length);
      if (dummy) {
        readBytesAcrossChunks(client, dummy, length);
        free(dummy);
      }
    }
  }

  unsigned long tEnd = millis();

  if (bargeInRequested) {
    Serial.println("🔘 Barge-in: skipping buffer flush");
  } else {
    const size_t dmaBytes = 8 * 1024 * 2 * 2;
    uint8_t* silence = (uint8_t*)calloc(1, dmaBytes);
    if (silence) {
      size_t written = 0;
      i2s_write(I2S_NUM_1, silence, dmaBytes, &written, portMAX_DELAY);
      free(silence);
    }
    Serial.printf("⏱️ end+[%lums] DMA flush\n", millis() - tEnd);
  }

  digitalWrite(PIN_AMP_SD, LOW);
  ampOn = false;
  Serial.printf("⏱️ end+[%lums] Amp off\n", millis() - tEnd);

  addToHistory("user", text);
  if (responseText.length() > 0) addToHistory("assistant", responseText);

  bargeInRequested = false;
  clearBackchannelCache();
  Serial.printf("⏱️ end+[%lums] Cleanup done\n", millis() - tEnd);

  i2s_stop(I2S_NUM_1);
  i2s_driver_uninstall(I2S_NUM_1);
  Serial.printf("⏱️ end+[%lums] I2S uninstalled\n", millis() - tEnd);

  startSTTRecording();
  Serial.printf("⏱️ end+[%lums] STT recording started\n", millis() - tEnd);
}

// ==== Soniox WebSocketイベント ====
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ Connected to Soniox!");
      {
        String startMsg =
          "{\"api_key\":\"" + sonioxKey + "\","
          "\"model\":\"" + sonioxModel + "\","
          "\"audio_format\":\"pcm_s16le\","
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox");
        // 録音中はタイマー停止（必須ではないが念のため）
        timerAlarm(ledTimer, 0, false, 0);
        setLEDMode(LED_ON);
      }
      isRecording = true;
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;
      if (msg.indexOf("\"tokens\"") >= 0) {
        String nonFinalCurrent = "";
        bool foundEndToken = false;
        int searchPos = msg.indexOf("\"tokens\"");
        while (true) {
          int textPos = msg.indexOf("\"text\":\"", searchPos);
          if (textPos < 0) break;
          textPos += 8;
          int textEnd = msg.indexOf("\"", textPos);
          if (textEnd < 0) break;
          String token = msg.substring(textPos, textEnd);

          int objEnd = msg.indexOf("}", textEnd);
          if (objEnd < 0) objEnd = msg.length();
          String objSlice = msg.substring(textEnd, objEnd);
          bool isFinal = objSlice.indexOf("\"is_final\":true") >= 0;

          if (token == "\\u003cend\\u003e") {
            foundEndToken = true;
          } else if (isFinal) {
            sonioxFinalBuf += token;
          } else {
            nonFinalCurrent += token;
          }
          searchPos = textEnd + 1;
        }

        String fullText = sonioxFinalBuf + nonFinalCurrent;
        if (fullText.length() > 0) {
          partialText = fullText;
          lastPartialMs = millis();
          armed = true;
          Serial.println(">> " + partialText);

          if (utf8Len(fullText) >= BACKCHANNEL_TRIGGER_CHARS && !backchannelFired && !backchannelFetching && !backchannelReady) {
            startBackchannelFetch(fullText);
          }
        }

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

    default:
      break;
  }
}

// ==== STT録音開始 ====
void startSTTRecording() {
  Serial.println("🎙️ Starting STT recording...");
  setLEDMode(LED_ON);

  setupI2SRecord();

  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);

  partialText = "";
  sonioxFinalBuf = "";
  lastFinalText = "";
  armed = false;
  endpointDetected = false;
  clearBackchannelCache();
}

// ==== WiFi接続（1回試行） ====
bool tryConnectWiFiOnce(const String& ssid, const String& password) {
  wifiConnected = false;
  wifiGotIP = false;

  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);

  wifi_country_t country = {
    .cc = "JP", .schan = 1, .nchan = 14, .max_tx_power = 20, .policy = WIFI_COUNTRY_POLICY_MANUAL
  };
  esp_wifi_set_country(&country);

  Serial.printf("📶 Connecting to: %s\n", ssid.c_str());
  WiFi.begin(ssid.c_str(), password.c_str());

  for (int i = 0; i < 10; i++) {
    delay(1000);
    Serial.print(".");
    if (wifiGotIP) return true;
  }
  return false;
}

// ==== BLEからのWiFi接続試行 ====
void tryConnectWiFiFromBLE(const String& ssid, const String& password) {
  sendBLEStatus("CONNECTING");

  Serial.printf("📶 Connecting to WiFi from BLE: %s\n", ssid.c_str());

  const int MAX_RETRIES = 5;
  for (int retry = 1; retry <= MAX_RETRIES; retry++) {
    Serial.printf("\n🔄 Attempt %d of %d\n", retry, MAX_RETRIES);
    if (tryConnectWiFiOnce(ssid, password)) {
      Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
      saveWiFiCredentials(ssid, password);
      wifiSSID = ssid;
      wifiPassword = password;
      deviceMacAddress = BLEDevice::getAddress().toString().c_str();
      saveDeviceMac(deviceMacAddress);
      sendBLEStatus("CONNECTED");
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

// ==== 通常動作開始 ====
void startNormalOperation() {
  Serial.println("🎯 Starting normal operation...");
  currentMode = MODE_NORMAL;

  HTTPClient http;
  String initUrl = String(SONIOX_LAMBDA_URL) + "?device_id=" + deviceMacAddress;
  http.begin(initUrl);
  int code = http.GET();
  if (code != 200) {
    setLEDMode(LED_OFF);
    return;
  }
  String resp = http.getString();
  http.end();

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    setLEDMode(LED_OFF);
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key obtained");

  if (doc.containsKey("backchannel_enabled")) {
    backchannelEnabled = doc["backchannel_enabled"].as<bool>();
  }
  if (doc.containsKey("stt_model")) {
    sonioxModel = doc["stt_model"].as<String>();
  }
  Serial.printf("🔊 Backchannel: %s, STT: %s\n", backchannelEnabled ? "ON" : "OFF", sonioxModel.c_str());

  startSTTRecording();
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(100);
  Serial.println("\n🚀 ToyTalker Mini v0.3");

  WiFi.onEvent(WiFiEvent);

  // LED初期化（digitalWriteのみ、PWMなし）
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);

  // LEDアニメーション用ハードウェアタイマー
  ledTimer = timerBegin(1000000);
  timerAttachInterrupt(ledTimer, &onLEDTimer);
  timerAlarm(ledTimer, 3000, true, 0);  // 3ms周期（擬似PWM用）

  // NVSからBLE MACアドレスを読み込み
  deviceMacAddress = loadDeviceMac();
  if (deviceMacAddress.length() > 0) {
    Serial.printf("📱 Device MAC (from NVS): %s\n", deviceMacAddress.c_str());
  }

  // ボタン初期化 + barge-in用割り込み
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onBargeInButton, FALLING);

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  if (loadWiFiCredentials()) {
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
      sessionId = String(millis()) + "-" + String(random(100000, 999999));
      Serial.printf("🆔 Session ID: %s\n", sessionId.c_str());
      startNormalOperation();
    } else {
      Serial.println("\n❌ WiFi connection failed, entering BLE provisioning mode");
      startBLE();
    }
  } else {
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
      buttonLongPressTriggered = true;
      if (currentMode == MODE_NORMAL) {
        Serial.println("🔘 Long press detected - Entering BLE mode");
        if (isRecording) { ws.disconnect(); isRecording = false; }
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
  if (currentMode == MODE_BLE_PROV) {
    handleButtonLongPress();
    if (!bleDeviceConnected && oldBleDeviceConnected) {
      delay(500);
      if (pServer) pServer->startAdvertising();
    }
    oldBleDeviceConnected = bleDeviceConnected;
    delay(10);
    return;
  }

  ws.loop();
  handleButtonLongPress();

  // ボタンデバウンス
  int reading = digitalRead(PIN_BUTTON);
  if (reading != lastButtonReading) lastDebounceTime = millis();
  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading != buttonState) {
      buttonState = reading;
    }
  }
  lastButtonReading = reading;

  // 録音データ送信
  if (isRecording && wifiGotIP && ws.isConnected()) {
    static uint32_t lastSend = 0;
    static uint32_t sendOk = 0, sendFail = 0;
    static uint32_t lastStats = 0;
    if (millis() - lastSend > 5) {
      int32_t raw[512];
      int16_t pcm[512];
      size_t n = 0;
      i2s_read(I2S_NUM_0, (void*)raw, sizeof(raw), &n, portMAX_DELAY);
      int samples = n / sizeof(int32_t);
      for (int i = 0; i < samples; i++) {
        pcm[i] = (int16_t)(raw[i] >> 14);
      }
      bool ok = ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      if (ok) sendOk++; else sendFail++;
      lastSend = millis();
    }
    if (millis() - lastStats > 5000) {
      Serial.printf("[STT] send ok=%d fail=%d RSSI=%d heap=%d\n", sendOk, sendFail, WiFi.RSSI(), ESP.getFreeHeap());
      sendOk = 0; sendFail = 0;
      lastStats = millis();
    }
  }

  // Sonioxエンドポイント検出
  if (endpointDetected && partialText.length() > 0) {
    if (partialText != lastFinalText) {
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    endpointDetected = false;
    armed = false;
    partialText = "";
    sonioxFinalBuf = "";
  }
  // 無音検出フォールバック
  else if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
    if (partialText != lastFinalText) {
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    armed = false;
    partialText = "";
    sonioxFinalBuf = "";
  }
}
