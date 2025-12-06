#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include "mbedtls/base64.h"

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda (TTS) ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
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

// ==== Soniox STT 状態 ====
WebSocketsClient ws;
String partialText = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;
bool isRecording = false;

// ==== TTS 受信状態 ====
String curEvent = "";
int curId = -1;
String curB64 = "";
bool inTtsJson = false;

// ==== 音量調整 ====
const float VOLUME = 0.3;

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
  if (err != ESP_OK) Serial.printf("❌ i2s_driver_install failed: %d\n", err);
  err = i2s_set_pin(I2S_NUM_0, &pins);
  if (err != ESP_OK) Serial.printf("❌ i2s_set_pin failed: %d\n", err);
  i2s_start(I2S_NUM_0);
}

// ==== I2S 再生設定 (TTS) ====
void setupI2SPlay() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);

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

// ==== TTS イベント終了処理 ====
void handleEventEnd() {
  if (curEvent == "tts" && curId >= 0 && curB64.length() > 0) {
    Serial.println("===== COMPLETE PCM =====");
    Serial.printf("id=%d, b64_len=%d\n", curId, curB64.length());

    size_t out_len = 0;
    int maxOut = curB64.length();
    uint8_t* mono_pcm = (uint8_t*)ps_malloc(maxOut);

    if (!mono_pcm) {
      Serial.println("[ERR] ps_malloc failed");
      curEvent = "";
      curId = -1;
      curB64 = "";
      inTtsJson = false;
      return;
    }

    int ret = mbedtls_base64_decode(
      mono_pcm, maxOut, &out_len,
      (const unsigned char*)curB64.c_str(),
      curB64.length()
    );

    Serial.printf("[DECODE] ret=%d, out_len=%d\n", ret, out_len);

    if (ret != 0 || out_len == 0) {
      Serial.println("[ERR] decode failed");
      free(mono_pcm);
      curEvent = "";
      curId = -1;
      curB64 = "";
      inTtsJson = false;
      return;
    }

    size_t samples = out_len / 2;
    size_t stereo_bytes = samples * 4;
    int16_t* stereo = (int16_t*)ps_malloc(stereo_bytes);

    if (!stereo) {
      Serial.println("[ERR] stereo ps_malloc failed");
      free(mono_pcm);
      curEvent = "";
      curId = -1;
      curB64 = "";
      inTtsJson = false;
      return;
    }

    monoToStereo((int16_t*)mono_pcm, stereo, samples);

    size_t written = 0;
    i2s_write(I2S_NUM_1, stereo, stereo_bytes, &written, portMAX_DELAY);
    Serial.printf("[I2S] written=%d bytes\n", written);

    free(stereo);
    free(mono_pcm);
    Serial.println("========================");
  }

  curEvent = "";
  curId = -1;
  curB64 = "";
  inTtsJson = false;
}

// ==== SSE行ごとの処理 ====
void processLine(String line) {
  line.trim();

  // chunk-size(hex) 行スキップ
  bool isHex = true;
  if (line.length() > 0) {
    for (int i = 0; i < line.length(); i++) {
      if (!isxdigit(line[i])) { isHex = false; break; }
    }
  }
  if (isHex && line.length() <= 4) return;

  // event:
  if (line.startsWith("event:")) {
    curEvent = line.substring(6);
    curEvent.trim();
    return;
  }

  // data:
  if (line.startsWith("data:")) {
    String d = line.substring(5);
    d.trim();

    if (curEvent == "tts" && d.startsWith("{")) {
      int p = d.indexOf("\"id\":");
      if (p >= 0) {
        p += 5;
        int e = p;
        while (e < d.length() && isdigit(d[e])) e++;
        curId = d.substring(p, e).toInt();
      }

      int b = d.indexOf("\"b64\":\"");
      if (b >= 0) {
        b += 7;
        String part = d.substring(b);
        part.replace("\"", "");
        curB64 += part;
      }

      inTtsJson = true;
    }
    return;
  }

  // TTS JSON 途中チャンク
  if (curEvent == "tts" && inTtsJson) {
    if (line.endsWith("\"}")) {
      String tmp = line;
      tmp.replace("\"}", "");
      curB64 += tmp;
      handleEventEnd();
      return;
    }

    curB64 += line;
    return;
  }
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  Serial.println("🚀 Sending to Lambda: " + text);

  // 録音停止
  if (isRecording) {
    ws.disconnect();
    isRecording = false;
    Serial.println("🛑 Stopped recording for TTS");
  }

  // I2S再生モードに切り替え
  i2s_driver_uninstall(I2S_NUM_0);
  setupI2SPlay();

  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  String payload =
    "{\"model\":\"OpenAI\",\"voice\":\"nova\","
    "\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  client.print(req);

  // HTTPヘッダ飛ばす
  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.println("📨 SSE START");

  // SSEボディ
  while (client.connected() || client.available()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      processLine(line);
    } else {
      delay(1);
    }
  }

  Serial.println("🏁 SSE END");
  handleEventEnd();

  // 再生完了後、録音再開
  delay(500);
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
          "\"model\":\"stt-rt-preview\","
          "\"audio_format\":\"pcm_s16le\","
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox");
      }
      isRecording = true;
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
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("❌ Soniox disconnected");
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

  // 既存のI2Sドライバーをアンインストール（再開時）
  i2s_driver_uninstall(I2S_NUM_0);
  i2s_driver_uninstall(I2S_NUM_1);

  setupI2SRecord();

  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);

  partialText = "";
  lastFinalText = "";
  armed = false;
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(500);
  Serial.println("\n🚀 ToyTalk Conversation (STT→LLM→TTS)");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  // WiFi接続
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  // Soniox temp key取得
  HTTPClient http;
  http.begin(SONIOX_LAMBDA_URL);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("❌ HTTP fail %d\n", code);
    return;
  }
  String resp = http.getString();
  http.end();

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    Serial.println("⚠️ JSON parse error");
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key obtained");

  // I2S再生設定
  setupI2SPlay();

  // STT録音開始
  delay(1000);
  startSTTRecording();
}

// ==== LOOP ====
void loop() {
  ws.loop();

  // 録音データをWebSocketに送信
  if (isRecording && WiFi.status() == WL_CONNECTED && ws.isConnected()) {
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

  // 無音検出 → 確定文出力（フォールバック）
  if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
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
