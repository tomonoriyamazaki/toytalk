#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "mbedtls/base64.h"
#include <driver/i2s.h>

// ==== WiFi設定 ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== I2S ====
#define PIN_WS     3
#define PIN_BCLK   4
#define PIN_DATA   9
#define PIN_DOUT   5
#define PIN_AMP_SD 6
#define SAMPLE_RATE 24000

// ==== I2S再生設定 ====
void setupI2SPlay() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
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

// ==== id単位のb64をデコードしてI2S再生 ====
void flushCurrentId(const String& id, String &b64accum, const String &fmt, int chunkCount) {
  if (b64accum.length() == 0) {
    Serial.printf("⚠️ id=%s no b64 to play\n", id.c_str());
    return;
  }
  Serial.printf("🎬 FLUSH id=%s totalB64=%d chunks=%d\n", id.c_str(), b64accum.length(), chunkCount);

  String cleanB64 = b64accum;
  cleanB64.replace("\n", "");
  cleanB64.replace("\r", "");
  cleanB64.trim();

  const size_t len = cleanB64.length();
  const size_t outLen = len * 3 / 4 + 8;
  uint8_t* pcm = (uint8_t*)malloc(outLen);
  if (!pcm) {
    Serial.println("💥 malloc failed");
    b64accum = "";
    return;
  }
  size_t decLen = 0;
  int rc = mbedtls_base64_decode(pcm, outLen, &decLen, (const unsigned char*)cleanB64.c_str(), len);
  Serial.printf("🔍 decode rc=%d, b64.len=%d, pcm.decLen=%d\n", rc, (int)len, (int)decLen);

  if (rc == 0 && decLen > 0) {
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(8);
    size_t written;
    i2s_write(I2S_NUM_1, pcm, decLen, &written, portMAX_DELAY);
    Serial.printf("🔊 I2S played %d bytes\n", (int)written);
    delay(20);
    digitalWrite(PIN_AMP_SD, LOW);
  } else {
    Serial.println("⚠️ decode failed or no data to play");
  }
  free(pcm);
  b64accum = "";
}

// ==== 1イベントブロックを処理（空行で閉じたSSEイベント） ====
void processEventBlock(const String& evBlock, String &currentId, String &curFmt, String &curB64, int &chunkIdx) {
  // イベント種別（なければ "message" 相当）
  String eventType = "";
  // このイベントの data: を結合したJSON
  String payload = "";

  // 行ごとに走査
  int start = 0;
  while (true) {
    int nl = evBlock.indexOf('\n', start);
    String line = (nl >= 0) ? evBlock.substring(start, nl) : evBlock.substring(start);
    // 素の行（CR除去）
    if (line.endsWith("\r")) line.remove(line.length() - 1);
    // event:
    if (line.startsWith("event:")) {
      eventType = line.substring(6);
      eventType.trim();
    }
    // data:
    if (line.startsWith("data:")) {
      String d = line.substring(5);
      // data: は複数行ある想定 → 改行で結合
      payload += d;
      payload += "\n";
    }
    if (nl < 0) break;
    start = nl + 1;
  }

  payload.trim();
  if (payload.length() == 0) return;

  // b64を含む巨大イベントからb64部分だけ抽出（tts専用）
  if (eventType == "tts" && payload.indexOf("\"b64\"") >= 0) {
    Serial.println("🎧 [tts event detected — extracting b64 and playing directly]");

    // b64抽出
    int b64Start = payload.indexOf("\"b64\":\"") + 7;
    int b64End = payload.indexOf("\"", b64Start);
    Serial.printf("🧠 b64Start=%d b64End=%d payload.len=%d\n", b64Start, b64End, payload.length());

    if (b64End > b64Start) {
      String b64 = payload.substring(b64Start, b64End);
      b64.replace("\n", "");
      b64.replace("\r", "");
      b64.trim();

      int previewHead = min(50, (int)b64.length());
      int previewTail = min(50, (int)b64.length());
      Serial.printf("🧩 b64.head(%d): %.50s\n", previewHead, b64.substring(0, previewHead).c_str());
      Serial.printf("🧩 b64.tail(%d): %.50s\n", previewTail, b64.substring(b64.length() - previewTail).c_str());
      Serial.printf("🎧 b64.len=%d\n", (int)b64.length());

      // --- デコードして再生 ---
      size_t outLen = b64.length() * 3 / 4 + 8;
      uint8_t* pcm = (uint8_t*)malloc(outLen);
      if (pcm) {
        size_t decLen = 0;
        int rc = mbedtls_base64_decode(pcm, outLen, &decLen,
                                       (const unsigned char*)b64.c_str(),
                                       b64.length());
        Serial.printf("🎧 decode rc=%d decLen=%d\n", rc, (int)decLen);
        if (rc == 0 && decLen > 0) {
          digitalWrite(PIN_AMP_SD, HIGH);
          delay(8);
          size_t written;
          i2s_write(I2S_NUM_1, pcm, decLen, &written, portMAX_DELAY);
          Serial.printf("🔊 I2S played %d bytes\n", (int)written);
          delay(20);
          digitalWrite(PIN_AMP_SD, LOW);
        } else {
          Serial.printf("⚠️ base64 decode failed rc=%d\n", rc);
        }
        free(pcm);
      } else {
        Serial.println("💥 malloc failed");
      }
    } else {
      Serial.println("⚠️ no b64 found in payload");
    }
    Serial.println("--- tts process end ---");
    return; // ttsイベント処理完了
  }


  // === 通常イベントは従来どおりJSONで処理 ===
  DynamicJsonDocument doc(32768);
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("❌ JSON parse error: %s\n", err.c_str());
    return;
  }


  // idの取り方（数値/文字列どちらもケア）
  String newId = "";
  if (doc["id"].is<const char*>()) newId = String(doc["id"].as<const char*>());
  else if (doc["id"].is<long>())   newId = String((long)doc["id"]);

  // id 切替検出 → 旧idを flush
  if (newId.length() > 0 && currentId.length() > 0 && newId != currentId) {
    Serial.printf("🔁 id change %s → %s\n", currentId.c_str(), newId.c_str());
    flushCurrentId(currentId, curB64, curFmt, chunkIdx);
    curFmt = "";
    chunkIdx = 0;
  }
  if (newId.length() > 0 && newId != currentId) {
    currentId = newId;
    Serial.printf("🆔 current id=%s\n", currentId.c_str());
  }

  // format
  if (doc["format"].is<const char*>()) {
    curFmt = String(doc["format"].as<const char*>());
    Serial.printf("🎚 format=%s\n", curFmt.c_str());
  }

  // b64
  if (doc["b64"].is<const char*>()) {
    const char* b64 = doc["b64"].as<const char*>();
    size_t pieceLen = strlen(b64);
    chunkIdx++;
    curB64.reserve(curB64.length() + pieceLen + 8);
    curB64 += b64;
    Serial.printf("   🔸 id=%s chunk#%d piece.len=%d total=%d\n",
                  currentId.c_str(), chunkIdx, (int)pieceLen, (int)curB64.length());
  }

  // final が来たら明示的に flush（Lambda側が付けないなら id切替/終端でflush）
  if (doc["final"].is<bool>() && (bool)doc["final"] == true) {
    Serial.printf("✅ id=%s final=true → flush now\n", currentId.c_str());
    flushCurrentId(currentId, curB64, curFmt, chunkIdx);
    curFmt = "";
    chunkIdx = 0;
    currentId = "";
  }
}

// ==== Lambda通信 ====
void sendToLambdaAndPlay(String text) {
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();
  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  // JSONペイロード
  String payload = "{\"model\":\"OpenAI\",\"voice\":\"nova\",\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";
  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n" +
    "Host: " + LAMBDA_HOST + "\r\n" +
    "Content-Type: application/json\r\n" +
    "Accept: text/event-stream\r\n" +
    "Connection: close\r\n" +
    "Content-Length: " + payload.length() + "\r\n\r\n" +
    payload;
  client.print(req);

  Serial.println("📡 Waiting SSE...");

  // ここから：イベントブロック組み立て（空行で1イベント完結）
  String evbuf = "";               // イベントブロック蓄積（ヘッダ＋data行）
  String currentId = "";           // いま収集中のid
  String curFmt = "";              // いま収集中のformat
  String curB64 = "";              // id単位で結合するb64
  int    chunkIdx = 0;             // id単位のチャンク数

  unsigned long lastDataMs = millis();
  const unsigned long TIMEOUT_MS = 15000; // ★ここ（要求通り場所を明示）

  while (true) {
    while (client.available()) {
      char c = client.read();
      evbuf += c;
      lastDataMs = millis();

      // 2連続改行 = 1イベント完結（CRLF/LF両対応）
      bool end1 = evbuf.endsWith("\n\n");
      bool end2 = evbuf.endsWith("\r\n\r\n");
      if (end1 || end2) {

        // segmentイベントのとき：text内容だけ抜き出してログ出力
        if (evbuf.indexOf("event: segment") >= 0 && evbuf.indexOf("\"text\"") >= 0) {
          int tPos = evbuf.indexOf("\"text\":\"");
          if (tPos >= 0) {
            int tEnd = evbuf.indexOf("\"", tPos + 8);
            if (tEnd > tPos) {
              String text = evbuf.substring(tPos + 8, tEnd);
              text.replace("\\n", "\n");
              text.replace("\\\"", "\"");
              Serial.printf("💬 segment text: %s\n", text.c_str());
            }
          }
        }

        // ttsイベントのとき：ログ出力、b64出力、PCMデコード、再生
        if (evbuf.indexOf("event: tts") >= 0) {
          Serial.println("🎯--- [tts event detected — printing full preview] ---");
          Serial.printf("📨 event block received len=%d\n", evbuf.length());
          Serial.printf("🧾 event block preview (first 300):\n%s\n", evbuf.substring(0, 300).c_str());
          int tailStart = std::max(0, (int)evbuf.length() - 300);
          Serial.printf("🧾 event block preview (last 300):\n%s\n", evbuf.substring(tailStart).c_str());

          // b64抽出
          // イベント内のbase64開始までの文字数 / Endまでの文字数を取得
          int b64Start = evbuf.indexOf("\"b64\":\"") + 7;
          int b64End = evbuf.indexOf("\"", b64Start);
          Serial.printf("🧠 b64Start=%d b64End=%d payload.len=%d\n", b64Start, b64End, payload.length());

          if (b64End > b64Start) {
            String b64 = evbuf.substring(b64Start, b64End);
            b64.replace("\n", "");
            b64.replace("\r", "");
            b64.replace("\\n", "");
            b64.replace("\\r", "");
            b64.trim();

            int previewHead = min(50, (int)b64.length());
            int previewTail = min(50, (int)b64.length());
            Serial.printf("🧩 b64.head(%d): %.50s\n", previewHead, b64.substring(0, previewHead).c_str());
            Serial.printf("🧩 b64.tail(%d): %.50s\n", previewTail, b64.substring(b64.length() - previewTail).c_str());
            Serial.printf("🎧 b64.len=%d\n", (int)b64.length());

            // --- デコードして再生 ---
            size_t outLen = b64.length() * 3 / 4 + 8;
            uint8_t* pcm = (uint8_t*)malloc(outLen);
            if (pcm) {
              size_t decLen = 0;
              int rc = mbedtls_base64_decode(pcm, outLen, &decLen,
                                            (const unsigned char*)b64.c_str(),
                                            b64.length());
              Serial.printf("🎧 decode rc=%d decLen=%d\n", rc, (int)decLen);
              if (rc == 0 && decLen > 0) {
                digitalWrite(PIN_AMP_SD, HIGH);
                delay(8);
                size_t written;
                i2s_write(I2S_NUM_1, pcm, decLen, &written, portMAX_DELAY);
                Serial.printf("🔊 I2S played %d bytes\n", (int)written);
                delay(20);
                digitalWrite(PIN_AMP_SD, LOW);
              } else {
                Serial.printf("⚠️ base64 decode failed rc=%d\n", rc);
              }
              free(pcm);
            } else {
              Serial.println("💥 malloc failed");
            }
          } else {
            Serial.println("⚠️ no b64 found in payload");
          }
          Serial.println("--- tts process end ---");
          return; // ttsイベント処理完了
        }


        // 空行だけのブロックはスキップ
        String tmp = evbuf; tmp.trim();
        if (tmp.length() == 0) {
          Serial.println("🔚 [empty event block]");
          evbuf = "";
          continue;
        }
        // 処理
        processEventBlock(evbuf, currentId, curFmt, curB64, chunkIdx);
        // 次のイベントへ
        evbuf = "";
      }
    }

    // ストリーム終端タイムアウト
    if (!client.connected() && client.available() == 0) {
      if (millis() - lastDataMs > TIMEOUT_MS) {
        Serial.println("⏹ No more data (timeout)");
        break;
      }
    }
    delay(1);
  }

  // 終了時、取り残しがあればflush
  if (curB64.length() > 0 && currentId.length() > 0) {
    Serial.printf("🧹 stream-end flush id=%s total=%d chunks=%d\n", currentId.c_str(), (int)curB64.length(), chunkIdx);
    flushCurrentId(currentId, curB64, curFmt, chunkIdx);
  }

  Serial.println("🏁 SSE Stream ended");
  digitalWrite(PIN_AMP_SD, LOW);
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(300);
  Serial.println("\n🚀 ToyTalk Unified STT→TTS Start");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  setupI2SPlay();

  // テストトリガ
  sendToLambdaAndPlay("こんにちは、私はトイトークです。");
}

void loop() {}
