#include <driver/i2s.h>

#define PIN_BCLK  7   // マイク SCK (BCLK)
#define PIN_WS    6   // マイク WS (LRCLK)
#define PIN_DATA  5   // マイク SD (DATA)

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("🎧 I2S Mic Test Start");

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 4,
    .dma_buf_len = 128,
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
}

void loop() {
  int32_t buffer[128];
  size_t bytes_read = 0;

  // ✅ Arduinoで使える正式な関数
  esp_err_t result = i2s_read(I2S_NUM_0, (void *)buffer, sizeof(buffer), &bytes_read, portMAX_DELAY);

  if (result == ESP_OK && bytes_read > 0) {
    int64_t sum = 0;
    for (int i = 0; i < 128; i++) {
      sum += abs(buffer[i]) >> 14;
    }
    int avg = sum / 128;
    Serial.println(avg);
  } else {
    Serial.println("read error or no data");
  }
}
