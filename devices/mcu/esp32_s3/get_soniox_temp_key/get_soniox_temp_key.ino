#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";
const char* LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

void setup() {
  Serial.begin(115200);
  delay(1000);

  // === Wi-Fi初期化 ===
  WiFi.disconnect(true, true);
  delay(1000);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  delay(500);

  Serial.printf("🚀 Connecting to %s...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("✅ WiFi connected!");
    Serial.println(WiFi.localIP());
  } else {
    Serial.printf("❌ Failed to connect (status %d)\n", WiFi.status());
  }

  Serial.println("✅ WiFi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // === Lambda呼び出し ===
  Serial.println("🌐 Requesting Soniox temp key...");
  HTTPClient http;
  http.begin(LAMBDA_URL);

  int httpCode = http.GET();
  if (httpCode > 0) {
    Serial.printf("📡 HTTP Response code: %d\n", httpCode);
    String payload = http.getString();
    Serial.println("🧾 Response payload:");
    Serial.println(payload);

    // JSONパース
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err && doc.containsKey("api_key")) {
      String key = doc["api_key"].as<String>();
      String expires = doc["expires_at"].as<String>();
      Serial.printf("✅ Soniox Temp Key: %s\n", key.c_str());
      Serial.printf("⏰ Expires at (UTC): %s\n", expires.c_str());
    } else {
      Serial.println("⚠️ Failed to parse JSON or 'api_key' not found");
    }
  } else {
    Serial.printf("❌ HTTP request failed: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}

void loop() {}
