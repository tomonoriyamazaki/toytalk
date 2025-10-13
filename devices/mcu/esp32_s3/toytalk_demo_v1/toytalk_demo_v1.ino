#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "mbedtls/base64.h"
#include <driver/i2s.h>

// ==== WiFi設定 ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda（PCMストリーミングSSE） ====
const char* LAMBDA_URL = "https://hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws/";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;

// ==== I2S ====
#define PIN_WS     3   // マイク WS / アンプ LRC（共有）
#define PIN_BCLK   4   // マイク SCK / アンプ BCLK（共有）
#define PIN_DATA   9   // マイク SD（I2S Data In）
#define PIN_DOUT   5   // アンプ Data Out
#define PIN_AMP_SD 6   // アンプ Shutdown
#define SAMPLE_RATE 24000

WebSocketsClient ws;
String partialText = "", lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;

// ==== I2S再生設定 ====
void setupI2SPlay() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
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
  i2s_start(I2S_NUM_1);
}

// ==== Lambdaへ確定文を送信してPCM再生 ====
void sendToLambdaAndPlay(String text) {
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect("hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws", 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  // JSONペイロード生成
  String payload = "{\"model\":\"OpenAI\",\"voice\":\"nova\",\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";
  String req =
    String("POST / HTTP/1.1\r\n") +
    "Host: hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws\r\n" +
    "Content-Type: application/json\r\n" +
    "Accept: text/event-stream\r\n" +
    "Connection: close\r\n" +
    "Content-Length: " + payload.length() + "\r\n\r\n" +
    payload;

  client.print(req);

  Serial.println("📡 Waiting SSE...");

  String line = "";
  String eventType = "";
  String dataAccum = "";
  bool inData = false;

  unsigned long lastDataMs = millis();
  const unsigned long TIMEOUT_MS = 2000; // 2秒無通信で終了

  while (true) {
    while (client.available()) {
      char c = client.read();
      line += c;
      lastDataMs = millis(); // データが来たら更新

      // 行終端判定
      if (line.endsWith("\n")) {
        line.trim();

        if (line.startsWith("event:")) {
          eventType = line.substring(6);
          eventType.trim();
        } 
        else if (line.startsWith("data:")) {
          // data行を蓄積（複数行対応）
          String chunk = line.substring(5);
          dataAccum += chunk;
          dataAccum += "\n";

          // b64途中ログ用にJSONが途中でも"b64"が含まれていたら出力
          if (chunk.indexOf("\"id\"") >= 0) {
            int idStart = chunk.indexOf("\"id\":");
            int idEnd = chunk.indexOf(",", idStart);
            String idStr = (idStart >= 0 && idEnd > idStart)
                ? chunk.substring(idStart + 5, idEnd)
                : "?";
            Serial.printf("🧩 partial event id=%s, chunk len=%d\n", idStr.c_str(), chunk.length());
          }

          // Base64文字列の途中プレビュー（b64が含まれている場合のみ）
          if (chunk.indexOf("b64") >= 0 || chunk.startsWith("\"") || chunk.startsWith("//")) {
            String preview = chunk;
            preview.replace("\n", "");
            preview.replace("\r", "");
            if (preview.length() > 80) preview = preview.substring(0, 80) + "...";
            Serial.printf("   └📦 partial b64 chunk (len=%d): %s\n", chunk.length(), preview.c_str());
          }
        }
        else if (line.length() == 0) {
          // 空行 = イベント終了。ただしJSONの閉じカッコ未到達なら待機
          int openBrace = dataAccum.indexOf("{");
          int closeBrace = dataAccum.lastIndexOf("}");
          if (openBrace < 0 || closeBrace < openBrace || dataAccum.indexOf("\"b64\"") < 0) {
            Serial.printf("⏸ waiting... len=%d (incomplete JSON, open=%d close=%d)\n", dataAccum.length(), openBrace, closeBrace);
            line = "";
            continue; // まだ来てない → 次のchunkを待つ
          } else {
            if (eventType == "tts" && dataAccum.length() > 0) {
              Serial.println("🎧 got TTS event");
              Serial.printf("📦 raw data len = %d\n", dataAccum.length());

              int lastBrace = dataAccum.lastIndexOf('{');
              String jsonStr = (lastBrace >= 0) ? dataAccum.substring(lastBrace) : dataAccum;
              jsonStr.trim();

              Serial.println("🧾 JSON content preview:");
              Serial.println(jsonStr.substring(0, 200));
              Serial.println("🧾 b64 content preview:");
              Serial.println(dataAccum.substring(0, 200));
              Serial.println(dataAccum.substring(dataAccum.length() - 200));
              Serial.println("--- end preview ---");

              DynamicJsonDocument doc(32768);
              auto err = deserializeJson(doc, jsonStr);
              if (err) {
                Serial.printf("❌ JSON parse error: %s\n", err.c_str());
              } else {
                const char* b64 = doc["b64"];
                const char* fmt = doc["format"];
                if (b64) {
                  String cleanB64 = String(b64);
                  cleanB64.replace("\n", "");
                  cleanB64.replace("\r", "");
                  cleanB64.trim();

                  size_t len = cleanB64.length();
                  Serial.printf("🧩 cleaned b64 len=%d\n", len);

                  // Base64末尾チェック（"="や"}"が来ていれば完結している）
                  if (!cleanB64.endsWith("=") && cleanB64.indexOf("}") < 0) {
                    Serial.println("⚠️ b64 incomplete, skipping playback until next chunk");
                  } else {
                    size_t outLen = len * 3 / 4 + 8;
                    uint8_t* pcm = (uint8_t*)malloc(outLen);
                    size_t decLen = 0;

                    int rc = mbedtls_base64_decode(
                      pcm, outLen, &decLen,
                      (const unsigned char*)cleanB64.c_str(), len
                    );
                    Serial.printf("🔍 decode rc=%d, outLen=%d, decLen=%d\n", rc, outLen, decLen);

                    if (rc == 0 && decLen > 0) {
                      bool isWav = fmt && (strcmp(fmt, "wav") == 0);
                      const uint8_t* playPtr = pcm;
                      size_t playLen = decLen;

                      if (isWav && decLen > 44) {
                        playPtr = pcm + 44;
                        playLen = decLen - 44;
                        Serial.println("🎧 Detected WAV header, skipping 44 bytes");
                      }

                      size_t written;
                      digitalWrite(PIN_AMP_SD, HIGH);
                      delay(10);
                      uint8_t silence[256] = {0};
                      i2s_write(I2S_NUM_1, silence, sizeof(silence), &written, portMAX_DELAY);
                      i2s_write(I2S_NUM_1, playPtr, playLen, &written, portMAX_DELAY);
                      Serial.printf("🔊 I2S wrote %d bytes (rate %d)\n", written, SAMPLE_RATE);
                      delay(50);
                      digitalWrite(PIN_AMP_SD, LOW);
                    } else {
                      Serial.println("⚠️ decode failed or no data to play");
                    }
                    free(pcm);
                  }
                } else {
                  Serial.println("⚠️ no b64 field found in JSON line");
                }
              }
              dataAccum = "";
              eventType = "";
            }
          }
          line = "";
        }

        line = "";
      }

    }
    
    // 接続が閉じられていても、しばらくは受信を待つ
    if (!client.connected() && client.available() == 0) {
      if (millis() - lastDataMs > TIMEOUT_MS) {
        Serial.println("⏹ No more data (timeout)");
        break;
      }
    }

    delay(1);
  }
  
  Serial.println("🏁 SSE Stream ended");
  digitalWrite(PIN_AMP_SD, LOW);
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(500);
  Serial.println("\n🚀 ToyTalk Unified STT→TTS Start");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  setupI2SPlay();

  // Lambdaに送るサンプルトリガ
  sendToLambdaAndPlay("こんにちは、私はトイトークです。");
}

void loop() {
  // ここに Soniox の確定文トリガを統合して呼ぶ
  // 例: if (newFinalText != lastFinalText) sendToLambdaAndPlay(newFinalText);
}
