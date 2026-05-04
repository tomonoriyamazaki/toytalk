#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// ==== WiFi設定（テスト用ハードコード） ====
const char* WIFI_SSID     = "Buffalo-G-5830";
const char* WIFI_PASSWORD = "sh6s3kagpp48s";

// ==== Soniox ====
const char* SONIOX_LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;
String sonioxModel = "stt-rt-v4";

// ==== I2S PIN (mini基板) ====
#define PIN_WS     3
#define PIN_BCLK   4
#define PIN_DATA   9
#define SAMPLE_RATE_STT 16000

// ==== 状態 ====
WebSocketsClient ws;
bool isConnected = false;
bool isRecording = false;

// ==== I2S 録音設定 ====
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

// ==== Soniox WebSocketイベント ====
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("Connected to Soniox!");
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
        Serial.println("Sent start message");
      }
      isRecording = true;
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;
      // シンプルにテキスト部分だけ抽出して表示
      String text = "";
      int pos = 0;
      while ((pos = msg.indexOf("\"text\":\"", pos)) >= 0) {
        pos += 8;
        int end = msg.indexOf("\"", pos);
        if (end < 0) break;
        String token = msg.substring(pos, end);
        if (token != "\\u003cend\\u003e") {
          text += token;
        }
      }
      if (text.length() > 0) {
        Serial.println(">> " + text);
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("Soniox disconnected");
      isRecording = false;
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(921600);
  delay(100);
  Serial.println("\n=== Mic Test (Mini) ===");

  // WiFi接続
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected! RSSI=%d\n", WiFi.RSSI());

  // Soniox temp key取得
  HTTPClient http;
  http.begin(SONIOX_LAMBDA_URL);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("HTTP fail %d\n", code);
    return;
  }
  String resp = http.getString();
  http.end();

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    Serial.println("JSON parse error");
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  if (doc.containsKey("stt_model")) {
    sonioxModel = doc["stt_model"].as<String>();
  }
  Serial.printf("Soniox key obtained, model=%s\n", sonioxModel.c_str());

  // I2S録音設定
  setupI2SRecord();
  Serial.println("I2S ready");

  // Soniox WebSocket接続
  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  Serial.println("Connecting to Soniox...");
}

void loop() {
  ws.loop();

  if (isRecording && ws.isConnected()) {
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
      Serial.printf("[STT] send ok=%d fail=%d RSSI=%d\n", sendOk, sendFail, WiFi.RSSI());
      sendOk = 0; sendFail = 0;
      lastStats = millis();
    }
  }
}
