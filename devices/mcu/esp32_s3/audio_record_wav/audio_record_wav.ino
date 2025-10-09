#include <driver/i2s.h>
#include "FS.h"
#include "SPIFFS.h"

#define PIN_BCLK  7
#define PIN_WS    6
#define PIN_DATA  5

#define SAMPLE_RATE   16000
#define RECORD_TIME   10
#define FILE_NAME     "/record.wav"

void writeWavHeader(File &file, uint32_t sampleRate, uint16_t bitsPerSample) {
  // PCM mono
  uint8_t header[44] = {
    'R','I','F','F', 0,0,0,0, 'W','A','V','E',
    'f','m','t',' ',16,0,0,0, 1,0, 1,0,   // PCM, mono
    0,0,0,0, 0,0,0,0,                    // sampleRate/byteRate
    0,0, 0,0,                            // blockAlign/bitsPerSample
    'd','a','t','a', 0,0,0,0
  };
  uint32_t byteRate = sampleRate * (bitsPerSample/8) * 1; // mono
  uint16_t blockAlign = (bitsPerSample/8) * 1;

  header[24] = (uint8_t)(sampleRate      ); header[25] = (uint8_t)(sampleRate>>8);
  header[26] = (uint8_t)(sampleRate>>16);  header[27] = (uint8_t)(sampleRate>>24);
  header[28] = (uint8_t)(byteRate       ); header[29] = (uint8_t)(byteRate>>8);
  header[30] = (uint8_t)(byteRate>>16   ); header[31] = (uint8_t)(byteRate>>24);
  header[32] = (uint8_t)(blockAlign     ); header[33] = (uint8_t)(blockAlign>>8);
  header[34] = (uint8_t)(bitsPerSample  ); header[35] = 0;

  file.write(header, 44);
}

void patchSizes(File &file) {
  uint32_t fileSize = file.size();
  uint32_t dataSize = fileSize - 44;
  file.seek(4);  file.write((uint8_t*)&fileSize, 4);
  file.seek(40); file.write((uint8_t*)&dataSize, 4);
}

void setup() {
  Serial.begin(921600);
  delay(800);

  if (!SPIFFS.begin(true)) { Serial.println("E: SPIFFS mount fail"); return; }

  // I2S init
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num  = PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num  = PIN_DATA
  };
  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
  i2s_start(I2S_NUM_0);

  // Record to SPIFFS
  File f = SPIFFS.open(FILE_NAME, FILE_WRITE);
  if (!f) { Serial.println("E: open fail"); return; }
  writeWavHeader(f, SAMPLE_RATE, 16);  // ← ここを32→16に変更

  Serial.println("🎙 Recording...");
  int32_t raw[512];   // I2Sからの32bitサンプル
  int16_t pcm[512];   // 書き込み用16bitバッファ
  size_t n = 0;
  uint32_t until = millis() + RECORD_TIME * 1000;

  while (millis() < until) {
    // 32bit読み込み
    i2s_read(I2S_NUM_0, (void*)raw, sizeof(raw), &n, portMAX_DELAY);
    int samples = n / sizeof(int32_t);

    // 上位16bitを抽出
    for (int i = 0; i < samples; i++) {
      pcm[i] = (int16_t)(raw[i] >> 14);  // ← 左詰めなので14〜16bit右シフト（14が自然）
    }

    // 16bitとして書き込み
    f.write((uint8_t*)pcm, samples * sizeof(int16_t));
  }
  patchSizes(f);
  f.close();
  i2s_driver_uninstall(I2S_NUM_0);
  Serial.println("✅ Recording complete.");
  Serial.printf("💾 %s size=%lu bytes\n", FILE_NAME, (unsigned long)SPIFFS.open(FILE_NAME, "r").size());

  // ── ここからバイナリ直送 ──
  File rf = SPIFFS.open(FILE_NAME, "r");
  if (!rf) { Serial.println("E: reopen fail"); return; }
  uint32_t wavSize = rf.size();
  Serial.printf("WAVSIZE:%lu\n", (unsigned long)wavSize);
  Serial.println("===BEGIN_BIN===");
  while (rf.available()) {
    size_t rd = rf.read(buf, sizeof(buf));
    Serial.write(buf, rd);   // バイナリをそのまま送出
  }
  Serial.println("\n===END_BIN===");
  rf.close();
  Serial.println("✅ Stream done");
}

void loop() {}
