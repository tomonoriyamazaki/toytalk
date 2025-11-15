#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "mbedtls/base64.h"
#include <driver/i2s.h>
#include <ctype.h>  // isxdigit用

// ==== WiFi設定 ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== I2S ピン・設定 ====
#define PIN_WS      3
#define PIN_BCLK    4
#define PIN_DATA    9   // 未使用（MAX98357AはDOUTだけ使う）
#define PIN_DOUT    5
#define PIN_AMP_SD  6
#define SAMPLE_RATE 24000

// ==== 再生用キュー設定 ====
struct AudioChunk {
  uint8_t* data;   // mono PCM (16bit LE)
  size_t   length; // bytes
};

static QueueHandle_t audioQueue = nullptr;
static const int AUDIO_QUEUE_LENGTH = 8;

// ==== I2S チャンク設定 ====
// 1回の i2s_write で流すステレオPCMバイト数
static const size_t I2S_WRITE_CHUNK_BYTES = 1024;

// mono 何サンプル分で 1024 bytes になるか
//  mono: 1サンプル=2byte
//  stereo: L/R 2ch → 4byte/monoサンプル
//  1024 / 4 = 256 monoサンプル
static const size_t MONO_SAMPLES_PER_CHUNK = 256;

// ==== I2S初期化 ====
void setupI2SPlay() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT, // ステレオ L/R
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num   = PIN_BCLK,
    .ws_io_num    = PIN_WS,
    .data_out_num = PIN_DOUT,
    .data_in_num  = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_set_clk(I2S_NUM_1, SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
  i2s_start(I2S_NUM_1);
}

// ==== 再生タスク ====
// キューから mono PCM を受け取り、L=R ステレオに展開して I2S に流す
void audioPlaybackTask(void* pv) {
  // ステレオ変換用ワークバッファ
  int16_t stereoBuf[MONO_SAMPLES_PER_CHUNK * 2]; // L/R で2倍

  for (;;) {
    AudioChunk chunk;
    if (xQueueReceive(audioQueue, &chunk, portMAX_DELAY) == pdTRUE) {
      if (!chunk.data || chunk.length == 0) {
        if (chunk.data) free(chunk.data);
        continue;
      }

      size_t monoSamples = chunk.length / 2;           // 16bit = 2byte
      int16_t* monoPCM   = (int16_t*)chunk.data;

      size_t sampleIndex = 0;
      while (sampleIndex < monoSamples) {
        size_t thisSamples = MONO_SAMPLES_PER_CHUNK;
        if (sampleIndex + thisSamples > monoSamples) {
          thisSamples = monoSamples - sampleIndex;
        }

        // mono → stereo(L=R)
        for (size_t i = 0; i < thisSamples; ++i) {
          int16_t s = monoPCM[sampleIndex + i];
          stereoBuf[2 * i]     = s; // L
          stereoBuf[2 * i + 1] = s; // R
        }

        size_t bytesToWrite = thisSamples * 2 /*ch*/ * sizeof(int16_t);
        size_t written = 0;
        i2s_write(I2S_NUM_1, stereoBuf, bytesToWrite, &written, portMAX_DELAY);
        sampleIndex += thisSamples;
      }

      free(chunk.data);
    }
  }
}

// ==== SSEの1イベントブロックから b64 を取り出してキューに入れる ====
void handleTtsEventBlock(const String& evBlock) {
  Serial.println("🎯--- [tts event detected] ---");
  Serial.printf("📨 event block len=%d\n", evBlock.length());

  int b64Start = evBlock.indexOf("\"b64\":\"");
  if (b64Start < 0) {
    Serial.println("⚠️ no \"b64\" found in tts event");
    return;
  }
  b64Start += 7;
  int b64End = evBlock.indexOf("\"", b64Start);
  if (b64End <= b64Start) {
    Serial.println("⚠️ invalid b64 range");
    return;
  }

  String b64 = evBlock.substring(b64Start, b64End);
  b64.replace("\n", "");
  b64.replace("\r", "");
  b64.replace("\\n", "");
  b64.replace("\\r", "");
  b64.trim();

  Serial.printf("🎧 b64.len=%d\n", (int)b64.length());

  size_t outLen = b64.length() * 3 / 4 + 8;
  uint8_t* pcm = (uint8_t*)malloc(outLen);
  if (!pcm) {
    Serial.println("💥 malloc failed for PCM");
    return;
  }

  size_t decLen = 0;
  int rc = mbedtls_base64_decode(
    pcm, outLen, &decLen,
    (const unsigned char*)b64.c_str(),
    b64.length()
  );
  Serial.printf("🎧 decode rc=%d decLen=%d\n", rc, (int)decLen);

  if (rc != 0 || decLen == 0) {
    Serial.println("⚠️ base64 decode failed");
    free(pcm);
    return;
  }

  // キューに積む
  AudioChunk chunk;
  chunk.data   = pcm;
  chunk.length = decLen;

  if (xQueueSend(audioQueue, &chunk, portMAX_DELAY) != pdTRUE) {
    Serial.println("⚠️ audioQueue full, dropping chunk");
    free(pcm);
  } else {
    Serial.printf("📥 queued PCM chunk len=%d bytes\n", (int)decLen);
  }
}

// ==== SSE の segment イベントから text をログに出す ====
void handleSegmentEventBlock(const String& evBlock) {
  int tPos = evBlock.indexOf("\"text\":\"");
  if (tPos < 0) return;
  int tEnd = evBlock.indexOf("\"", tPos + 8);
  if (tEnd <= tPos) return;

  String text = evBlock.substring(tPos + 8, tEnd);
  text.replace("\\n", "\n");
  text.replace("\\\"", "\"");
  Serial.printf("💬 segment text: %s\n", text.c_str());
}

// ==== Lambda通信（SSE受信 → PCMをキューへ） ====
// ★ここを整理＆修正
void sendToLambdaAndPlay(const String& text) {
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(5000); // 行単位読み取りのタイムアウト

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  // JSONペイロード
  String payload = "{\"model\":\"OpenAI\",\"voice\":\"nova\","
                   "\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";

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

  // ==== 1. HTTPレスポンスヘッダを読み飛ばす ====
  while (client.connected()) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0) break;
    if (line == "\r") break; // 空行 = ヘッダ終端
  }

  // ==== 2. SSE本体（chunked）を行単位で読む ====
  String evbuf;
  unsigned long lastDataMs = millis();
  const unsigned long TIMEOUT_MS = 15000;

  while (client.connected() || client.available()) {
    if (!client.available()) {
      if (millis() - lastDataMs > TIMEOUT_MS) {
        Serial.println("⏹ No more data (timeout)");
        break;
      }
      delay(10);
      continue;
    }

    String line = client.readStringUntil('\n');
    lastDataMs = millis();

    String trimmed = line;
    trimmed.trim();

    // 空行 → 1イベントの終端
    if (trimmed.length() == 0) {
      if (evbuf.length() == 0) {
        continue;
      }

      // ★ 追加：イベント中身をそのまま出力 ★
      Serial.println("===== EVENT BLOCK (RAW) =====");
      Serial.println(evbuf);

      // イベント種別判定
      if (evbuf.indexOf("event: segment") >= 0) {
        handleSegmentEventBlock(evbuf);
      } else if (evbuf.indexOf("event: tts") >= 0) {
        handleTtsEventBlock(evbuf);
      }

      evbuf = "";
      continue;
    }


    // chunk サイズ行（例: "94", "ffa", "2000"）は無視
    bool isChunkSize = true;
    for (int i = 0; i < trimmed.length(); ++i) {
      char ch = trimmed.charAt(i);
      if (!isxdigit((unsigned char)ch)) {
        isChunkSize = false;
        break;
      }
    }
    if (isChunkSize) {
      // 例: "94", "ffa" など → 何もしない
      continue;
    }

    // 上記どれにも当てはまらない → イベント本文としてバッファに追加
    evbuf += line;
  }

  Serial.println("🏁 SSE Stream ended");
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(300);
  Serial.println("\n🚀 ToyTalk TTS Player Start");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);  // 常に有効にしておく（ノイズ対策は後で調整）

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  setupI2SPlay();

  audioQueue = xQueueCreate(AUDIO_QUEUE_LENGTH, sizeof(AudioChunk));
  if (!audioQueue) {
    Serial.println("💥 audioQueue create failed");
    for (;;) delay(1000);
  }

  xTaskCreate(
    audioPlaybackTask,
    "audioPlayback",
    4096,
    nullptr,
    1,
    nullptr
  );

  // テストトリガ
  sendToLambdaAndPlay("こんにちは、私はトイトークです。");
}

void loop() {
  // 今は1回だけ送信テスト。今後はボタンやSTTトリガにする想定。
}
