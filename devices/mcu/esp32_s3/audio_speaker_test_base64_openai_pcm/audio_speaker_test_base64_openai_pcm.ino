#include <driver/i2s.h>
#include "raw_pcm_test_1s.h"

#define PIN_BCLK   4
#define PIN_LRC    3
#define PIN_DOUT   5
#define PIN_AMP_SD 6

// モノラルPCM → ステレオPCM 変換
// (L=mono, R=mono)
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  for (size_t i = 0; i < samples; i++) {
    stereo[2*i]     = mono[i]; // Left
    stereo[2*i + 1] = mono[i]; // Right
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("🔊 I2S Stereo Playback Test");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH);

  // ===== I2S 設定 =====
  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = 24000,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
      .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,  // ★ステレオ明示
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
  i2s_set_clk(I2S_NUM_1, 24000, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);

  // ===== モノラルPCM → ステレオPCM =====
  size_t mono_bytes = c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm_len;
  size_t mono_samples = mono_bytes / 2;

  int16_t* mono = (int16_t*)c__Users_exodj_Documents_Audacity_raw_pcm_test_1s_pcm;
  int16_t* stereo = (int16_t*) malloc(mono_bytes * 2);   // ★2倍メモリ

  monoToStereo(mono, stereo, mono_samples);

  size_t written;
  esp_err_t ret = i2s_write(
    I2S_NUM_1,
    stereo,
    mono_bytes * 2,  // ★ステレオなので2倍量
    &written,
    portMAX_DELAY
  );

  Serial.printf("I2S written = %d bytes\n", written);

  free(stereo);
}

void loop() {}
