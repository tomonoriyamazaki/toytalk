#include <driver/i2s.h>

/*** === 新配線に対応したピン定義 === ***/
// I2S 共有クロック
#define PIN_WS     3   // マイクWS / アンプLRC（共有）
#define PIN_BCLK   4   // マイクSCK / アンプBCLK（共有）
#define PIN_DATA   9   // マイクSD（INMP441 → ESP32 の Data In）

// アンプ（省電力制御。録音のみならLOWのままでOK）
#define PIN_AMP_SD 6   // HIGH=動作, LOW=シャットダウン

// 参考：今回は未実装でも支障なし（入れておいてOK）
#define PIN_LED    8
#define PIN_BTN    7

// 必要に応じて 0/1 を切り替えて試せるように
#define MIC_PORT   I2S_NUM_0   // うまく行かなければ I2S_NUM_1 に変更

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("🎧 I2S Mic Test (new wiring: WS=3, BCLK=4, SD=9)");

  // アンプは録音テスト中はOFFでOK（ノイズ防止＆省電力）
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  // 未実装でも問題なし（LED/BTNは無視される）
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);

  // ==== I2S（マイク）設定：Master | RX（ESPがBCLK/WSを出す）====
  i2s_config_t i2s_cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,         // INMP441 は24bit相当だが32で受けるのが定番
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,          // LRピンをGND=Left固定
    .communication_format = I2S_COMM_FORMAT_I2S,          // I2S standard, MSB-first
    .intr_alloc_flags = 0,
    .dma_buf_count = 6,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num   = PIN_BCLK,      // GPIO4
    .ws_io_num    = PIN_WS,        // GPIO3
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num  = PIN_DATA       // GPIO9
  };

  esp_err_t err = i2s_driver_install(MIC_PORT, &i2s_cfg, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("i2s_driver_install failed: %d\n", err);
  }
  err = i2s_set_pin(MIC_PORT, &pins);
  if (err != ESP_OK) {
    Serial.printf("i2s_set_pin failed: %d\n", err);
  }
  err = i2s_start(MIC_PORT);
  if (err != ESP_OK) {
    Serial.printf("i2s_start failed: %d\n", err);
  }

  Serial.println("✅ Mic ready. Speak and watch values...");
}

void loop() {
  static int32_t buffer[256];
  size_t bytes_read = 0;

  esp_err_t r = i2s_read(MIC_PORT, (void*)buffer, sizeof(buffer), &bytes_read, portMAX_DELAY);
  if (r != ESP_OK || bytes_read == 0) {
    Serial.println("read error or no data");
    delay(10);
    return;
  }

  // ざっくりレベル表示（32bitサンプル想定）
  int n = bytes_read / sizeof(int32_t);
  int64_t acc = 0;
  for (int i = 0; i < n; i++) {
    // INMP441は24bitデータがMSB側に乗ることが多いので、右にシフトして扱いやすく
    acc += llabs(buffer[i] >> 14);
  }
  int avg = (int)(acc / n);
  Serial.println(avg);

  // 閾値でLED点灯（物理LED未接続でも問題なし）
  digitalWrite(PIN_LED, (avg > 80) ? HIGH : LOW);
}
