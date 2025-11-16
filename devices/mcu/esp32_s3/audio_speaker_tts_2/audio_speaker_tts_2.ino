#include <WiFi.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";


// =========================
// ★ イベントを flush
// =========================
void flushEvent(const String& type, int id, const String& b64, const String& json)
{
  if (type.length() == 0) return;

  Serial.println("🟦 ===== LOGICAL EVENT ===== ");

  Serial.printf("event: %s\n", type.c_str());
  Serial.printf("id: %d\n", id);
  Serial.printf("json: %s\n", json.c_str());

  if (b64.length() > 0) {
    Serial.println("🟩 merged b64:");
    Serial.println(b64);
    Serial.printf("len=%d\n", b64.length());
  } else {
    Serial.println("❗ no b64 in this event");
  }

  Serial.println("-------------------------------");
}


// =========================
// ★ hex判定（chunk-size）
// =========================
bool isChunkSize(const String& s)
{
  if (s.length() == 0 || s.length() > 6) return false;

  for (int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (!isxdigit((unsigned char)c)) return false;
  }
  return true;
}



// =========================
// ★ SSE受信（行パース）
// =========================
void sendSimpleSSE(const String& text)
{
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(8000);

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    return;
  }

  // ---- リクエスト ----
  String payload =
    "{\"model\":\"OpenAI\",\"voice\":\"nova\","
    "\"messages\":[{\"role\":\"user\",\"content\":\"" + text + "\"}]}";

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n" +
    payload;

  client.print(req);


  // ---- HTTP header ----
  while (true) {
    String l = client.readStringUntil('\n');
    if (l.length() == 0 || l == "\r") break;
  }


  // ============================
  // ★ 本体：行単位で読む
  // ============================
  String currentType = "";
  int currentId = -1;
  String currentB64 = "";
  String currentJson = "";

  String line = "";

  while (client.connected() || client.available()) {

    line = client.readStringUntil('\n');
    String t = line;
    t.trim();

    // ★ chunk-size 行 → 無視
    if (isChunkSize(t)) continue;

    // ★ 新しい event
    if (t.startsWith("event:")) {
      // 前のイベントを flush
      flushEvent(currentType, currentId, currentB64, currentJson);

      // 新イベント開始
      currentType = t.substring(6);
      currentType.trim();
      currentId = -1;
      currentB64 = "";
      currentJson = "";
      continue;
    }

    // ★ data 行
    if (t.startsWith("data:")) {
      currentJson = t.substring(5);
      currentJson.trim();

      // id 抽出
      int idPos = currentJson.indexOf("\"id\":");
      if (idPos >= 0) {
        int comma = currentJson.indexOf(",", idPos);
        String idVal = currentJson.substring(idPos + 5, comma);
        currentId = idVal.toInt();
      }

      // b64 抽出
      int p = currentJson.indexOf("\"b64\":\"");
      if (p >= 0) {
        p += 7;
        int e = currentJson.indexOf("\"", p);
        if (e > p) {
          String b = currentJson.substring(p, e);
          b.replace("\\n", "");
          b.replace("\\r", "");
          currentB64 += b;
        }
      }
    }
  }

  // ★ 最後のイベントも flush
  flushEvent(currentType, currentId, currentB64, currentJson);

  Serial.println("🏁 SSE END");
}




void setup() {
  Serial.begin(921600);
  delay(200);
  Serial.println("🚀 SSE LOGICAL EVENT PARSER");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.printf("✅ WiFi OK: %s\n", WiFi.localIP().toString().c_str());

  sendSimpleSSE("こんにちは、テストです。");
}

void loop() {}
