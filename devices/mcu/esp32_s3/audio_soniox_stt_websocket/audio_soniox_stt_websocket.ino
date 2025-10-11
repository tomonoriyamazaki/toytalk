#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// === WiFi設定 ===
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// === Lambda ===
const char* LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

// === Soniox ===
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;

// === I2S設定 ===
#define PIN_BCLK 7
#define PIN_WS 6
#define PIN_DATA 5
#define SAMPLE_RATE 16000

WebSocketsClient ws;

// リアルタイム／確定ロジック用変数
String partialText = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;

void setup() {
  Serial.begin(921600);
  delay(500);
  Serial.println("\n🚀 Soniox RealTime STT Start");

  // WiFi 接続
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  // Lambda から temp key 取得
  HTTPClient http;
  http.begin(LAMBDA_URL);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("❌ HTTP fail %d\n", code);
    return;
  }
  String payload = http.getString();
  http.end();
  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, payload)) {
    Serial.println("⚠️ JSON parse error");
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key: " + sonioxKey);

  // I2S 初期化
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
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

  // WebSocket 接続
  Serial.println("🌐 Connecting Soniox WebSocket...");
  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.setExtraHeaders(("Authorization: Bearer " + sonioxKey).c_str());
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();

  // 1) 音声データを読み取って送信
  static uint32_t lastSend = 0;
  if (millis() - lastSend > 5 && WiFi.status() == WL_CONNECTED && ws.isConnected()) {
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

  // 2) 無音検出 → 確定文出力
  if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
    // 重複確定を防ぐ
    if (partialText != lastFinalText) {
      Serial.println("\n✅ 確定文:");
      Serial.println(partialText);
      lastFinalText = partialText;
    }
    // リセット
    armed = false;
    partialText = "";
  }
}

// === WebSocketイベント ===
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ Connected to Soniox!");
      {
        String startMsg =
          "{\"api_key\":\"" + sonioxKey + "\"," 
          "\"model\":\"stt-rt-preview\"," 
          "\"audio_format\":\"pcm_s16le\"," 
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox: " + startMsg);
      }
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;

      if (msg.indexOf("\"tokens\"") >= 0) {
        String newText = "";
        int pos = 0;
        while ((pos = msg.indexOf("\"text\":\"", pos)) >= 0) {
          pos += 8;
          int end = msg.indexOf("\"", pos);
          if (end < 0) break;
          String token = msg.substring(pos, end);
          if (token != "\\u003cend\\u003e") newText += token;
        }

        // 置き換え対象：case WStype_TEXT 内の処理
        if (newText.length() > 0) {
          // 差分検出
          int overlap = 0;
          while (overlap < partialText.length() && overlap < newText.length()) {
            if (partialText.substring(partialText.length() - overlap) == newText.substring(0, overlap)) {
              break;
            }
            overlap++;
          }

          // 差分だけを追記（全文置き換えではない）
          if (newText.startsWith(partialText)) {
            // 正常に延長
            partialText = newText;
          } else {
            // 重複部分を除去して追加
            if (overlap > 0 && overlap < newText.length()) {
              partialText += newText.substring(overlap);
            } else if (newText != partialText) {
              partialText = newText; // 全く違う文なら置き換え
            }
          }

          lastPartialMs = millis();
          armed = true;
          Serial.println("📝 " + partialText);
        }
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("❌ Soniox disconnected");
      break;

    default:
      break;
  }
}

