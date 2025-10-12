#include <driver/i2s.h>

#define PIN_BCLK   4   // アンプ BCLK（マイクと共有）
#define PIN_LRC    3   // アンプ LRC（マイクと共有）
#define PIN_DIN    5   // アンプ DIN（音声データ入力）
#define PIN_AMP_SD 6   // アンプ SD（HIGHでON）

#define SAMPLE_RATE 16000

void setup() {
  Serial.begin(115200);
  Serial.println("🔊 Speaker Test Start");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);  // 🔛 アンプON

  // I2S 設定
  i2s_config_t i2s_cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = 0,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_LRC,
    .data_out_num = PIN_DIN,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_1, &i2s_cfg, 0, NULL);  // 🔁 TXはI2S_NUM_1推奨（RXと分離）
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_start(I2S_NUM_1);
}

void loop() {
  const int samples = 256;
  int16_t buffer[samples];
  static float phase = 0.0;
  const float freq = 440.0;  // A4(ラ)
  const float increment = 2.0 * PI * freq / SAMPLE_RATE;

  for (int i = 0; i < samples; i++) {
    buffer[i] = (int16_t)(sin(phase) * 3000); // 音量控えめ
    phase += increment;
    if (phase >= 2.0 * PI) phase -= 2.0 * PI;
  }

  size_t written;
  i2s_write(I2S_NUM_1, buffer, sizeof(buffer), &written, portMAX_DELAY);
}
