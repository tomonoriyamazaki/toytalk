#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "mbedtls/base64.h"

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda ====
const char* LAMBDA_HOST = "hbik6fueesqaftzkehtbwrr2ra0ucusi.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ===== 状態 =====
String curEvent = "";
int curId = -1;
String curB64 = "";
bool inTtsJson = false;

// ===== ★追加：chunk 即 decode → I2S再生 =====
void playChunk(const String& b64part) {
  if (b64part.length() == 0) return;

  size_t out_len = 0;
  int maxOut = b64part.length();
  uint8_t* pcm = (uint8_t*)malloc(maxOut);
  if (!pcm) return;

  mbedtls_base64_decode(
      pcm, maxOut, &out_len,
      (const unsigned char*)b64part.c_str(),
      b64part.length()
  );

  if (out_len > 0) {
    // ★ I2S に流す（とものりさまの既存コードでOK）
    i2s_write(I2S_NUM_0, pcm, out_len, &out_len, portMAX_DELAY);
  }

  free(pcm);
}

// ===== イベント終了処理 =====
void handleEventEnd() {
  if (curEvent == "tts" && curId >= 0 && curB64.length() > 0) {
    Serial.println("===== COMPLETE PCM =====");
    Serial.printf("id=%d\n", curId);
    Serial.printf("b64_len=%d\n", curB64.length());
    Serial.println(curB64);

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

// ===== 行処理 =====
void processLine(String line) {
  line.trim();

  // ---- chunk-size(hex) 行スキップ ----
  bool isHex = true;
  if (line.length() > 0) {
    for (int i = 0; i < line.length(); i++) {
      if (!isxdigit(line[i])) { isHex = false; break; }
    }
  }
  if (isHex && line.length() <= 4) return;

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
      int p = d.indexOf("\"id\":");
      if (p >= 0) {
        p += 5;
        int e = p;
        while (e < d.length() && isdigit(d[e])) e++;
        curId = d.substring(p, e).toInt();
      }

      int b = d.indexOf("\"b64\":\"");
      if (b >= 0) {
        b += 7;
        String part = d.substring(b);
        part.replace("\"", "");

        // ★★★ 追加：ここで即decode → 再生 ★★★
        playChunk(part);

        curB64 += part;
      }

      inTtsJson = true;
    }
    return;
  }

  // ---- TTS JSON の途中チャンク ----
  if (curEvent == "tts" && inTtsJson) {

    // 終端 "}"
    if (line.endsWith("\"}")) {
      String tmp = line;
      tmp.replace("\"}", "");

      // ★★★ decode → 再生 ★★★
      playChunk(tmp);

      curB64 += tmp;

      handleEventEnd();
      return;
    }

    // ★★★ base64 続き（即再生）★★★
    playChunk(line);

    curB64 += line;
    return;
  }
}
