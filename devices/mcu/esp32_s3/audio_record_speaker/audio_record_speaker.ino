#include <driver/i2s.h>
#include "esp32-hal-psram.h"

#define I2S_WS   3
#define I2S_BCK  4
#define I2S_DIN  9
#define I2S_DOUT 5
#define AMP_SD   6
#define SAMPLE_RATE 16000
#define RECORD_MS   5000
#define BUFFER_SAMPLES (SAMPLE_RATE * RECORD_MS / 1000)

int16_t *pcmBuffer = nullptr;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("🎙️ Record + Playback Test (RAM / PSRAM)");

  pinMode(AMP_SD, OUTPUT);
  digitalWrite(AMP_SD, LOW);

  if (!psramFound()) {
    Serial.println("⚠️ PSRAM not found, fallback to internal RAM");
  }

  pcmBuffer = (int16_t *) ps_malloc(BUFFER_SAMPLES * sizeof(int16_t));
  if (!pcmBuffer) {
    Serial.println("❌ ps_malloc failed!");
    while (1);
  }

  // ==== 録音I2S設定 ====
  i2s_config_t rec_cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  i2s_pin_config_t rec_pins = {
    .bck_io_num = I2S_BCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_DIN
  };

  i2s_driver_install(I2S_NUM_0, &rec_cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &rec_pins);
  i2s_start(I2S_NUM_0);

  Serial.println("🎧 Recording 10 seconds...");
  size_t bytes_read;
  int32_t raw;
  for (int i = 0; i < BUFFER_SAMPLES; i++) {
    i2s_read(I2S_NUM_0, &raw, sizeof(raw), &bytes_read, portMAX_DELAY);
    pcmBuffer[i] = (int16_t)(raw >> 14);
  }

  i2s_driver_uninstall(I2S_NUM_0);
  Serial.println("✅ Recording done.");

  // ==== 再生I2S設定 ====
  i2s_config_t play_cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };
  i2s_pin_config_t play_pins = {
    .bck_io_num = I2S_BCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_0, &play_cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &play_pins);
  i2s_start(I2S_NUM_0);

  Serial.println("🔊 Playing...");
  digitalWrite(AMP_SD, HIGH);
  delay(10);

  size_t bytes_written;
  i2s_write(I2S_NUM_0, pcmBuffer, BUFFER_SAMPLES * sizeof(int16_t), &bytes_written, portMAX_DELAY);

  digitalWrite(AMP_SD, LOW);
  Serial.println("✅ Playback done.");
}

void loop() {}
