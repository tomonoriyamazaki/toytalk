#include <driver/i2s.h>

#define PIN_BCLK   4   // アンプ BCLK（マイクと共有）
#define PIN_LRC    3   // アンプ LRC（マイクと共有）
#define PIN_DIN    5   // アンプ DIN（音声データ入力）
#define PIN_AMP_SD 6   // アンプ SD（HIGHでON）

#define SAMPLE_RATE 16000

// 🎵 音階（Hz）
#define NOTE_C3  131
#define NOTE_D3  147
#define NOTE_E3  165
#define NOTE_F3  175
#define NOTE_G3  196
#define NOTE_A3  220
#define NOTE_AS3 233
#define NOTE_B3  247
#define NOTE_C4  262
#define NOTE_D4  294
#define NOTE_E4  330
#define NOTE_F4  349
#define NOTE_G4  392
#define NOTE_A4  440
#define NOTE_B4  494
#define NOTE_C5  523
#define NOTE_R   0  // 休符

// 🎵 スーパーマリオ風フレーズ
int melody[][2] = {
  {NOTE_E4,150},{NOTE_E4,150},{NOTE_R,150},{NOTE_E4,150},
  {NOTE_R,150},{NOTE_C4,150},{NOTE_E4,150},{NOTE_G4,150},
  {NOTE_R,450},{NOTE_G3,150},{NOTE_R,300},{NOTE_C4,150},
  {NOTE_R,150},{NOTE_G3,150},{NOTE_R,150},{NOTE_E3,150},
  {NOTE_R,300},{NOTE_A3,150},{NOTE_B3,150},{NOTE_A3,150},
  {NOTE_AS3,150},{NOTE_B3,150},{NOTE_R,150},{NOTE_E4,150},
};

void playTone(int freq, int durationMs) {
  const int samples = 256;
  int16_t buffer[samples];
  size_t written;
  float phase = 0.0;
  float step = 2.0 * PI * freq / SAMPLE_RATE;
  unsigned long start = millis();

  while (millis() - start < durationMs) {
    for (int i = 0; i < samples; i++) {
      buffer[i] = (freq == 0) ? 0 : (int16_t)(sin(phase) * 3000);
      phase += step;
      if (phase > 2 * PI) phase -= 2 * PI;
    }
    i2s_write(I2S_NUM_1, buffer, sizeof(buffer), &written, portMAX_DELAY);
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("🎵 Mario Melody Test");

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, HIGH); // アンプON

  i2s_config_t cfg = {
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

  i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_start(I2S_NUM_1);
}

void loop() {
  for (int i = 0; i < sizeof(melody)/sizeof(melody[0]); i++) {
    int note = melody[i][0];
    int duration = melody[i][1];
    playTone(note, duration);
    delay(20);
  }
  delay(1000);
}
