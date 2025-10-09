#include <driver/i2s.h>
#include "FS.h"
#include "SPIFFS.h"

#define PIN_BCLK  7
#define PIN_WS    6
#define PIN_DATA  5

#define SAMPLE_RATE 16000
#define RECORD_TIME 10  // 録音秒数
#define FILE_NAME "/record.wav"

void setup() {
  Serial.begin(115200);
  if(!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_DATA
  };

  i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pin_config);
  i2s_start(I2S_NUM_0);

  recordWav();
}

void loop() {}

void recordWav() {
  File file = SPIFFS.open(FILE_NAME, FILE_WRITE);
  if (!file) {
    Serial.println("Failed to open file for writing");
    return;
  }

  // WAVヘッダを仮書き
  writeWavHeader(file, SAMPLE_RATE, 32);

  Serial.println("🎙 Recording...");
  uint32_t bytesToRecord = SAMPLE_RATE * RECORD_TIME * 4; // 32bit = 4bytes/sample
  uint8_t buffer[512];
  size_t bytesRead;

  uint32_t totalBytes = 0;
  while (totalBytes < bytesToRecord) {
    i2s_read(I2S_NUM_0, (void *)buffer, sizeof(buffer), &bytesRead, portMAX_DELAY);
    file.write(buffer, bytesRead);
    totalBytes += bytesRead;
  }

  Serial.println("✅ Recording complete.");

  // WAVヘッダ更新
  updateWavHeader(file);

  file.close();
  Serial.println("💾 Saved to /record.wav (SPIFFS)");
}

void writeWavHeader(File &file, int sampleRate, int bitsPerSample) {
  uint8_t header[44] = {
    'R','I','F','F', 0,0,0,0, 'W','A','V','E',
    'f','m','t',' ',16,0,0,0,1,0,1,0,
    0,0,0,0,0,0,0,0,4,0,32,0,
    'd','a','t','a',0,0,0,0
  };
  uint32_t byteRate = sampleRate * bitsPerSample / 8;
  header[24] = (uint8_t)(sampleRate & 0xff);
  header[25] = (uint8_t)((sampleRate >> 8) & 0xff);
  header[26] = (uint8_t)((sampleRate >> 16) & 0xff);
  header[27] = (uint8_t)((sampleRate >> 24) & 0xff);
  header[28] = (uint8_t)(byteRate & 0xff);
  header[29] = (uint8_t)((byteRate >> 8) & 0xff);
  header[30] = (uint8_t)((byteRate >> 16) & 0xff);
  header[31] = (uint8_t)((byteRate >> 24) & 0xff);
  file.write(header, 44);
}

void updateWavHeader(File &file) {
  uint32_t fileSize = file.size();
  uint32_t dataSize = fileSize - 44;

  file.seek(4);
  file.write((uint8_t *)&fileSize, 4);
  file.seek(40);
  file.write((uint8_t *)&dataSize, 4);
}
