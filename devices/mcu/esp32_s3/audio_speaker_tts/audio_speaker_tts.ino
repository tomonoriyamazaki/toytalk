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

  // evBlock の中にある "b64":"xxxxx" をすべて抽出して結合
  String b64all = "";
  int searchPos = 0;

  while (true) {
    int b64Start = evBlock.indexOf("\"b64\":\"", searchPos);
    if (b64Start < 0) break;
    b64Start += 7;

    int b64End = evBlock.indexOf("\"", b64Start);
    if (b64End <= b64Start) break;

    // 部分 b64 を追加
    String part = evBlock.substring(b64Start, b64End);
    part.replace("\n", "");
    part.replace("\r", "");
    part.replace("\\n", "");
    part.replace("\\r", "");
    part.trim();

    b64all += part;
    searchPos = b64End + 1;
  }

  Serial.printf("📏 b64 total length = %d chars\n", b64all.length());

  // ====== ここから下は従来の PCM 変換処理（必要なら残す） ======

  if (b64all.length() == 0) {
    Serial.println("⚠️ no b64 found");
    return;
  }

  size_t outLen = b64all.length() * 3 / 4 + 8;
  uint8_t* pcm = (uint8_t*)malloc(outLen);
  if (!pcm) {
    Serial.println("💥 malloc failed");
    return;
  }

  size_t decLen = 0;
  int rc = mbedtls_base64_decode(
    pcm, outLen, &decLen,
    (const unsigned char*)b64all.c_str(),
    b64all.length()
  );

  Serial.printf("🎧 decode rc=%d decLen=%d\n", rc, (int)decLen);

  if (rc != 0 || decLen == 0) {
    Serial.println("⚠️ base64 decode failed");
    free(pcm);
    return;
  }

  AudioChunk chunk;
  chunk.data   = pcm;
  chunk.length = decLen;

  if (xQueueSend(audioQueue, &chunk, portMAX_DELAY) != pdTRUE) {
    Serial.println("⚠️ audioQueue full, dropping");
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


// ==== chunkサイズを読んで、そのバイト数だけ本文を読む ====
bool readChunk(WiFiClientSecure &client, String &out)
{
  out = "";

  // chunkサイズ行を読む（例: "ffa", "2000", "61"）
  String sizeLine = client.readStringUntil('\n');
  sizeLine.trim();
  if (sizeLine.length() == 0) return false;

  // hex → 数値
  int chunkSize = strtol(sizeLine.c_str(), NULL, 16);
  if (chunkSize <= 0) return false;  // 0 = 終端

  // chunk本体
  for (int i = 0; i < chunkSize; i++) {
    while (!client.available()) delay(1);
    char c = client.read();
    out += c;
  }

  // chunk末尾の "\r\n" を読み捨てる
  while (client.available()) {
    char c = client.peek();
    if (c == '\r' || c == '\n') client.read();
    else break;
  }

  return true;
}


// ==== Lambda通信（SSE受信 → PCMをキューへ） ====
// ★ここを整理＆修正
void sendToLambdaAndPlay(const String& text)
{
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(5000);

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
  Serial.println("📡 Waiting SSE...");

  // HTTP header skip
  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  // ==== 2. SSE本体（行ごとに読むだけ） ====
  String evbuf = "";

  while (client.connected() || client.available()) {

      if (!client.available()) {
          delay(5);
          continue;
      }

      String line = client.readStringUntil('\n');

      // ログ：受信した行をそのまま表示
      Serial.print("[RAW] ");
      Serial.println(line);

      // 空行 → 1イベントの終端
      String trimmed = line;
      trimmed.trim();

      if (trimmed.length() == 0) {
          if (evbuf.length() > 0) {
              Serial.println("===== EVENT BLOCK =====");
              Serial.println(evbuf);
              Serial.println("===== END EVENT BLOCK =====");
              evbuf = "";
          }
          continue;
      }

      // イベント本文として追加
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
