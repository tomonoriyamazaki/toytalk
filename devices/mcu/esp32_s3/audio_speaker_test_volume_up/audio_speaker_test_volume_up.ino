#include <driver/i2s.h>
#include "raw_pcm_test_1s.h"

#define PIN_BCLK   4
#define PIN_LRC    3
#define PIN_DOUT   5
#define PIN_AMP_SD 6

void setup() {
  Serial.begin(115200);
  Serial.println("🔊 I2S Raw PCM 再生テスト開始");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);

  // ===== I2S 設定 =====
  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = 24000,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
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
  i2s_set_clk(I2S_NUM_1, 24000, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO);

  // ===== PCMをコピー（※ROM上のデータを編集できないため）=====
  uint8_t* buf = (uint8_t*) malloc(c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len);
  memcpy(buf, c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm,
         c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len);

  Serial.printf("PCMサイズ = %d bytes\n", c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len);

  // ===== 🔥 PCM音量アップ（1.6倍） =====
  float gain = 1.6f;  // ← 1.3〜1.8 が推奨。2.0 以上は歪む可能性あり

  for (size_t i = 0; i + 1 < c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len; i += 2) {
    int16_t s = (int16_t)(buf[i] | (buf[i + 1] << 8));  // LE 16bit を読み取り
    float amplified = s * gain;

    // クリッピング（必須）
    if (amplified > 32767.0f) amplified = 32767.0f;
    if (amplified < -32768.0f) amplified = -32768.0f;

    int16_t out = (int16_t)amplified;

    buf[i]     = out & 0xFF;        // LSB
    buf[i + 1] = (out >> 8) & 0xFF; // MSB
  }

  // ===== 再生 =====
  size_t written;
  esp_err_t ret = i2s_write(
    I2S_NUM_1,
    buf,
    c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len,
    &written,
    portMAX_DELAY
  );

  if (ret == ESP_OK) {
    Serial.printf("🎧 再生完了（%d bytes）\n", written);
  } else {
    Serial.printf("❌ i2s_write failed: %d\n", ret);
  }

  free(buf);
}

void loop() {}
