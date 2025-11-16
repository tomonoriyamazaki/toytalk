#include <WiFi.h>
#include <WiFiClientSecure.h>

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ===== 追加: 受信状態 =====
String curEvent = "";
int curId = -1;
String curB64 = "";
bool inTtsJson = false;

// ===== 追加: イベント終了処理 =====
void handleEventEnd() {
  if (curEvent == "tts" && curId >= 0 && curB64.length() > 0) {
    Serial.println("===== COMPLETE PCM =====");
    Serial.printf("id=%d\n", curId);
    Serial.printf("b64_len=%d\n", curB64.length());
    Serial.println(curB64);

    // base64の末尾30表示
    int n = curB64.length();
    String tail = curB64.substring(n > 30 ? n - 30 : 0);
    Serial.printf("tail30=\"%s\"\n", tail.c_str());

    Serial.println("========================");
  }
  curEvent = "";
  curId = -1;
  curB64 = "";
  inTtsJson = false;
}

// ===== 追加: 行ごとの処理 =====
void processLine(String line) {
  line.trim();

  // ---- chunk-size(hex) 行スキップ ----
  bool isHex = true;
  if (line.length() > 0) {
    for (int i = 0; i < line.length(); i++) {
      if (!isxdigit(line[i])) { isHex = false; break; }
    }
  }
  if (isHex && line.length() <= 4) {
    return;
  }

  // ---- event: ----
  if (line.startsWith("event:")) {
    handleEventEnd();
    curEvent = line.substring(6);
    curEvent.trim();
    return;
  }

  // ---- data: 最初の JSON ----
  if (line.startsWith("data:")) {
    String d = line.substring(5);
    d.trim();

    if (curEvent == "tts" && d.startsWith("{")) {
      // id
      int p = d.indexOf("\"id\":");
      if (p >= 0) {
        p += 5;
        int e = p;
        while (e < d.length() && isdigit(d[e])) e++;
        curId = d.substring(p, e).toInt();
      }

      // b64（途中のため " が無い場合あり）
      int b = d.indexOf("\"b64\":\"");
      if (b >= 0) {
        b += 7;
        String part = d.substring(b);
        part.replace("\"", "");
        curB64 += part;
      }

      inTtsJson = true;
    }
    return;
  }

  // ---- TTS JSON の途中チャンク ----
  if (curEvent == "tts" && inTtsJson) {

    // 終端 "}" チェック
    if (line.endsWith("\"}")) {
      String tmp = line;
      tmp.replace("\"}", "");
      curB64 += tmp;
      handleEventEnd();
      return;
    }

    // base64 続き
    curB64 += line;
    return;
  }

  // 他の行は無視
}

// ==== Lambda に固定メッセージ送って SSE を処理 ====
void sendSimpleSSE(const String& text)
{
  Serial.println("🚀 Sending to Lambda: " + text);

  WiFiClientSecure client;
  client.setInsecure();

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

  // ---- SSEボディ ----
  while (client.connected() || client.available()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      Serial.print("[RAW] ");
      Serial.println(line);
      processLine(line);   // ★追加
    } else {
      delay(1);
    }
  }

  Serial.println("🏁 SSE END ----------------------------------");

  handleEventEnd();  // 念のため
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
