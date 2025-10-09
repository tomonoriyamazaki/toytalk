#include "FS.h"
#include "SPIFFS.h"
#include "base64.h"

void setup() {
  Serial.begin(115200);
  if(!SPIFFS.begin(true)){
    Serial.println("❌ SPIFFS Mount Failed");
    return;
  }

  File file = SPIFFS.open("/record.wav", "r");
  if(!file){
    Serial.println("❌ File not found: /record.wav");
    return;
  }

  Serial.println("===BEGIN_BASE64===");
  while(file.available()){
    uint8_t buf[64];
    size_t n = file.read(buf, sizeof(buf));
    String encoded = base64::encode(buf, n);
    Serial.print(encoded);
  }
  Serial.println("===END_BASE64===");
  file.close();
}

void loop() {}
