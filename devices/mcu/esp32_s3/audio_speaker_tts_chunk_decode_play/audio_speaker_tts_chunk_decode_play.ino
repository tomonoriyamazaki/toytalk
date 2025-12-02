#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <driver/i2s.h>
#include "mbedtls/base64.h"

// ========= WiFi =========
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ========= Lambda =========
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ========= I2S PIN =========
#define PIN_BCLK   4
#define PIN_LRC    3
#define PIN_DOUT   5
#define PIN_AMP_SD 6

// ========= SSE 状態 =========
String curEvent = "";
int curId = -1;
bool inTtsJson = false;

// ========= mono → stereo 変換 =========
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  for (size_t i = 0; i < samples; i++) {
    stereo[2*i]     = mono[i];
    stereo[2*i + 1] = mono[i];
  }
}

// ========= base64 chunk decode → I2S 再生 =========
void playChunk(const String& b64part) {
  if (b64part.length() == 0) return;

  Serial.printf("[CHUNK] len=%d\n", b64part.length());

  size_t out_len = 0;
  int maxOut = b64part.length();
  uint8_t* mono_pcm = (uint8_t*)malloc(maxOut);
  if (!mono_pcm) {
    Serial.println("[ERR] malloc failed");
    return;
  }

  int ret = mbedtls_base64_decode(
      mono_pcm, maxOut, &out_len,
      (const unsigned char*)b64part.c_str(),
      b64part.length()
  );

  Serial.printf("[DECODE] out=%d  ret=%d\n", out_len, ret);

  if (ret != 0 || out_len == 0) {
    Serial.println("[DECODE] decode failed");
    free(mono_pcm);
    return;
  }

  size_t samples = out_len / 2;
  size_t stereo_bytes = samples * 4;

  int16_t* stereo = (int16_t*)malloc(stereo_bytes);
  if (!stereo) {
    Serial.println("[ERR] stereo malloc failed");
    free(mono_pcm);
    return;
  }

  monoToStereo((int16_t*)mono_pcm, stereo, samples);

  size_t written = 0;
  i2s_write(I2S_NUM_1, stereo, stereo_bytes, &written, portMAX_DELAY);

  Serial.printf("[I2S] written=%d\n", written);

  free(stereo);
  free(mono_pcm);
}


// ========= event 終了処理（ログのみ） =========
void handleEventEnd() {
  curEvent = "";
  curId = -1;
  inTtsJson = false;
}

// ========= 行ごと解析 =========
void processLine(String line) {
  line.trim();

  // chunk-size(hex) 行を無視
  bool isHex = true;
  if (line.length() > 0) {
    for (int i = 0; i < line.length(); i++) {
      if (!isxdigit(line[i])) { isHex = false; break; }
    }
  }
  if (isHex && line.length() <= 4) return;

  // event:
  if (line.startsWith("event:")) {
    handleEventEnd();
    curEvent = line.substring(6);
    curEvent.trim();
    return;
  }

  // data: {...}
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

        // ここで chunk 再生
        playChunk(part);
      }

      inTtsJson = true;
    }
    return;
  }

  // TTS 途中チャンク
  if (curEvent == "tts" && inTtsJson) {

    if (line.endsWith("\"}")) {
      String tmp = line;
      tmp.replace("\"}", "");

      playChunk(tmp);
      handleEventEnd();
      return;
    }

    playChunk(line);
    return;
  }
}

// ========= Lambda に送信 & SSE解析 =========
void sendSimpleSSE(const String& text)
{
  Serial.println("🚀 Sending to Lambda: " + text);

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

  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  // SSE ボディ
  while (client.connected() || client.available()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      processLine(line);
    } else {
      delay(1);
    }
  }

  handleEventEnd();
}

// ========= I2S セットアップ =========
void setupI2S() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);

  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = 24000,
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
      .ws_io_num = PIN_LRC,
      .data_out_num = PIN_DOUT,
      .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_set_clk(I2S_NUM_1, 24000, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
}

// ========= setup =========
void setup() {
  Serial.begin(921600);
  delay(200);

  setupI2S();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  sendSimpleSSE("こんにちは、とものりさま。テストです。");
}

void loop() {}
