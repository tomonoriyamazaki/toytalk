#include <WiFi.h>

const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

void setup() {
  Serial.begin(115200);
  delay(1000);

  // 重要: WiFiを明示的にリセットしてから開始
  WiFi.disconnect(true, true);  // ← WiFiモジュール完全リセット
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);

  Serial.println("🔍 Scanning WiFi networks...");
  int n = WiFi.scanNetworks();
  Serial.println("Scan done");

  if (n == 0) {
    Serial.println("❌ No networks found");
  } else {
    Serial.printf("📡 %d networks found:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("%2d: %s (RSSI: %d)\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
    }
  }

  // スキャン後に接続
  Serial.println("\nConnecting WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 30) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi failed to connect");
    Serial.print("Status: ");
    Serial.println(WiFi.status());
  }
}

void loop() {}
