#include <WiFi.h>

const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

void setup() {
  Serial.begin(115200);
  delay(1000);

  // 🔧 Wi-Fi初期化（確実にスキャン動作させるための定番処理）
  WiFi.disconnect(true, true);   // 以前の接続情報を完全クリア
  delay(500);
  WiFi.mode(WIFI_STA);           // ステーションモードに設定
  WiFi.setSleep(false);          // ← 追加！ スリープモード解除
  delay(500);

  Serial.println("🔍 Scanning networks...");
  int n = WiFi.scanNetworks(false, true);
  Serial.printf("📡 %d networks found:\n", n);

  // もしネットワークがゼロなら即リターン
  if (n <= 0) {
    Serial.println("❌ No networks found");
    return;
  }

  // 🔎 見つけた全ネットワークを出力してデバッグ
  for (int i = 0; i < n; i++) {
    Serial.printf("  %d: %s (ch:%d, RSSI:%d, enc:%d)\n",
      i + 1,
      WiFi.SSID(i).c_str(),
      WiFi.channel(i),
      WiFi.RSSI(i),
      WiFi.encryptionType(i)
    );
  }

  // ✅ 一致するSSIDがあれば、BSSID指定で接続
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    int channel = WiFi.channel(i);
    wifi_auth_mode_t enc = WiFi.encryptionType(i);
    uint8_t* bssid = WiFi.BSSID(i);

    if (ssid == WIFI_SSID && enc == WIFI_AUTH_WPA2_PSK && channel <= 13) {
      Serial.printf("✅ Found 2.4GHz BSSID: %02X:%02X:%02X:%02X:%02X:%02X (ch:%d)\n",
        bssid[0], bssid[1], bssid[2], bssid[3], bssid[4], bssid[5], channel);
      WiFi.begin(WIFI_SSID, WIFI_PASS, channel, bssid);
      break;
    }
  }

  // 🕒 接続待機
  Serial.print("Connecting");
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("✅ WiFi connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.printf("❌ Failed to connect (status %d)\n", WiFi.status());
  }
}

void loop() {}
