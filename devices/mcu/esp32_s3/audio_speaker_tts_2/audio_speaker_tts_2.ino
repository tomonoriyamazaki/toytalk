#include <WiFi.h>
#include <WiFiClientSecure.h>

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== Lambda に固定メッセージ送って SSE を全部ログに出すだけ ====
void sendSimpleSSE(const String& text)
{
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure(); // 証明書無視

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  // 送信ペイロード
  String payload =
    "{\"model\":\"OpenAI\",\"voice\":\"nova\","
    "\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";

  // HTTPリクエスト
  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  client.print(req);

  Serial.println("📡 Waiting SSE header...");

  // ---- HTTPヘッダ飛ばす ----
  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;  
  }

  Serial.println("📨 SSE START --------------------------------");

  // ---- SSEボディをそのまま全部ログ ----
  while (client.connected() || client.available()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      Serial.print("[SSE] ");
      Serial.println(line);
    } else {
      delay(1);
    }
  }

  Serial.println("🏁 SSE END ----------------------------------");
}

void setup() {
  Serial.begin(921600);
  delay(200);

  Serial.println("🚀 Minimal SSE logger start");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n✅ WiFi connected: %s\n", WiFi.localIP().toString().c_str());

  // ---- テスト送信 ----
  sendSimpleSSE("こんにちは、テストです");
}

void loop() {
}
