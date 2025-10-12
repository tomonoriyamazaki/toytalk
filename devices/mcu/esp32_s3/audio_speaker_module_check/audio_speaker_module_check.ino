#include <driver/i2s.h>
#include <math.h>
#define PIN_BCLK 4
#define PIN_WS   3
#define PIN_DIN  5
#define PIN_SD   6
#define SR 16000
void setup(){
  pinMode(PIN_SD, OUTPUT);
  digitalWrite(PIN_SD, HIGH); // 常時ON
  i2s_config_t c={ (i2s_mode_t)(I2S_MODE_MASTER|I2S_MODE_TX), SR,
    I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_FMT_ONLY_LEFT, I2S_COMM_FORMAT_I2S_MSB,
    0,4,512,false,true,0 };
  i2s_pin_config_t p={ PIN_BCLK, PIN_WS, PIN_DIN, I2S_PIN_NO_CHANGE };
  i2s_driver_install(I2S_NUM_1,&c,0,NULL);
  i2s_set_pin(I2S_NUM_1,&p);
  i2s_start(I2S_NUM_1);
}
void loop(){
  static int16_t w[512]; static float ph=0,inc=2*M_PI*440.0/SR;
  for(int i=0;i<512;i++){ w[i]=(int16_t)(sin(ph)*10000); ph+=inc; if(ph>2*M_PI) ph-=2*M_PI; }
  size_t wr; i2s_write(I2S_NUM_1,w,sizeof(w),&wr,portMAX_DELAY);
}
