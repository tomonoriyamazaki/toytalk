#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <driver/i2s.h>
#include "mbedtls/base64.h"

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ===== 追加: 受信状態 =====
String curEvent = "";
int curId = -1;
String curB64 = "";
bool inTtsJson = false;

// =======================================
//      ==== I2S ADD: 初期化 ====
// =======================================
#define PIN_BCLK   4
#define PIN_LRC    3
#define PIN_DOUT   5
#define PIN_AMP_SD 6

void initI2S() {
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

  Serial.println("🔊 I2S initialized");
}

// モノラルPCM → ステレオPCM
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  for (size_t i = 0; i < samples; i++) {
    stereo[2*i]     = mono[i];
    stereo[2*i + 1] = mono[i];
  }
}

// =======================================
//         イベント終了処理（元コード）
// =======================================
void handleEventEnd() {

  if (curEvent == "tts" && curId >= 0 && curB64.length() > 0) {
    Serial.println("===== COMPLETE PCM =====");
    Serial.printf("id=%d\n", curId);
    Serial.printf("b64_len=%d\n", curB64.length());
    Serial.println(curB64);

    // base64の末尾30表示
    int n = curB64.length();
    String tail = curB64.substring(n > 30 ? n - 30 : 0);
    Serial.printf("tail30=\"%s\"\n", tail.c_str());
    Serial.println("========================");

    // =======================================
    //     ==== I2S ADD: base64 → 再生 ====
    // =======================================
    {
      Serial.println("🎧 [PLAY] Start PCM decode");

      // --- base64 decode ---
      size_t bin_len = curB64.length() * 3 / 4 + 4;
      uint8_t* bin = (uint8_t*) malloc(bin_len);
      if (!bin) {
        Serial.println("❌ malloc decode");
      } else {
        int ret = mbedtls_base64_decode(bin, bin_len, &bin_len,
                                        (const unsigned char*)curB64.c_str(),
                                        curB64.length());
        if (ret != 0) {
          Serial.printf("❌ base64 decode error=%d\n", ret);
          free(bin);
        } else {
          // --- モノラル16bitPCM → ステレオ変換 ---
          size_t mono_samples = bin_len / 2;
          int16_t* mono = (int16_t*)bin;

          size_t stereo_bytes = mono_samples * 4;
          int16_t* stereo = (int16_t*) malloc(stereo_bytes);
          if (!stereo) {
            Serial.println("❌ malloc stereo");
            free(bin);
          } else {
            monoToStereo(mono, stereo, mono_samples);

            size_t written;
            esp_err_t r = i2s_write(
              I2S_NUM_1,
              stereo,
              stereo_bytes,
              &written,
              portMAX_DELAY
            );

            Serial.printf("I2S written = %d bytes\n", written);
            free(stereo);
            free(bin);
          }
        }
      }
      Serial.println("🎧 [PLAY END]");
    }

  }

  // 元の後処理
  curEvent = "";
  curId = -1;
  curB64 = "";
  inTtsJson = false;
}

// =======================================
//          以下、TTSの元コード（変更なし）
// =======================================
void processLine(String line) {
  line.trim();

  bool isHex = true;
  if (line.length() > 0) {
    for (int i = 0; i < line.length(); i++) {
      if (!isxdigit(line[i])) { isHex = false; break; }
    }
  }
  if (isHex && line.length() <= 4) {
    return;
  }

  if (line.startsWith("event:")) {
    handleEventEnd();
    curEvent = line.substring(6);
    curEvent.trim();
    return;
  }

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

  if (curEvent == "tts" && inTtsJson) {

      // 行末が '}' なら JSON 終端
      if (line.endsWith("}")) {

          // 前の余分な " を除去（あってもなくてもOK）
          String tmp = line;
          tmp.replace("\"}", "");  // "}" →  }  に
          tmp.replace("}", "");    // 最後の } を削除
          curB64 += tmp;

          handleEventEnd();
          return;
      }

      // 途中行ならそのまま追加
      curB64 += line;
      return;
  }

}

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

  Serial.println("📡 Waiting SSE header...");

  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.println("📨 SSE START --------------------------------");

  while (client.connected() || client.available()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      Serial.print("[RAW] ");
      Serial.println(line);
      processLine(line);
    } else {
      delay(1);
    }
  }

  Serial.println("🏁 SSE END ----------------------------------");

  handleEventEnd();
}

void setup() {
  Serial.begin(921600);
  delay(200);

  Serial.println("🚀 Minimal SSE logger start");

  // ==== I2S 追加 ====
  initI2S();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected: %s\n", WiFi.localIP().toString().c_str());

  sendSimpleSSE("こんにちは、テストです");
}

void loop() {}
