#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// ==== デバッグ設定 ====
#define DEBUG_MEMORY 0  // メモリ診断を有効化する場合は1に設定

// ==== WiFi ====
const char* WIFI_SSID = "Buffalo-G-5830";
const char* WIFI_PASS = "sh6s3kagpp48s";

// ==== Lambda (TTS) - Binary Streaming ====
const char* LAMBDA_HOST = "koufofwm3w4tidbe52crbyhpyq0cshss.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== Lambda (Soniox Key) ====
const char* SONIOX_LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;

// ==== I2S PIN ====
#define PIN_WS     3
#define PIN_BCLK   4
#define PIN_DATA   9
#define PIN_DOUT   5
#define PIN_AMP_SD 6
#define SAMPLE_RATE_STT 16000
#define SAMPLE_RATE_TTS 24000

// ==== LED & Button ====
#define PIN_LED    8
#define PIN_BUTTON 7
#define LED_CHANNEL 0
#define LED_FREQ 5000
#define LED_RESOLUTION 8

// LED状態
enum LEDMode {
  LED_OFF,
  LED_ON,
  LED_BREATHING,  // ふわふわ（録音中）
  LED_BLINKING    // 点滅（再生中）
};

LEDMode currentLEDMode = LED_OFF;
unsigned long lastLEDUpdate = 0;
int breathingValue = 0;
bool breathingUp = true;
bool blinkState = false;

// ボタン状態
int lastButtonReading = HIGH;
int buttonState = HIGH;
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

// ==== Soniox STT 状態 ====
WebSocketsClient ws;
String partialText = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;
bool isRecording = false;

// ==== TTS 受信状態 ====
int curSegmentId = -1;
String responseText = "";
uint8_t* currentPcmBuffer = NULL;
size_t currentPcmSize = 0;

// ==== 会話履歴 (直近5回分) ====
const int MAX_HISTORY = 5;
struct Message {
  String role;
  String content;
};
Message conversationHistory[MAX_HISTORY * 2];
int historyCount = 0;

// ==== 音量調整 ====
const float VOLUME = 1.0;

// ==== メモリ診断関数 ====
#if DEBUG_MEMORY
void printMemoryStatus(const char* label) {
  Serial.println("========================================");
  Serial.printf("[MEMORY] %s\n", label);
  Serial.println("========================================");

  // 総合メモリ情報
  Serial.printf("Total Heap:      %7d bytes\n", ESP.getHeapSize());
  Serial.printf("Free Heap:       %7d bytes\n", ESP.getFreeHeap());
  Serial.printf("Used Heap:       %7d bytes\n", ESP.getHeapSize() - ESP.getFreeHeap());
  Serial.println("----------------------------------------");

  // 内部RAM詳細
  uint32_t internalTotal = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
  uint32_t internalFree = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  uint32_t internalUsed = internalTotal - internalFree;
  Serial.printf("Internal RAM Total: %7d bytes\n", internalTotal);
  Serial.printf("Internal RAM Free:  %7d bytes\n", internalFree);
  Serial.printf("Internal RAM Used:  %7d bytes (%.1f%%)\n",
                internalUsed, (float)internalUsed / internalTotal * 100);
  Serial.println("----------------------------------------");

  // PSRAM詳細
  uint32_t psramTotal = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
  uint32_t psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  uint32_t psramUsed = psramTotal - psramFree;
  Serial.printf("PSRAM Total:        %7d bytes\n", psramTotal);
  Serial.printf("PSRAM Free:         %7d bytes\n", psramFree);
  Serial.printf("PSRAM Used:         %7d bytes (%.1f%%)\n",
                psramUsed, (float)psramUsed / psramTotal * 100);
  Serial.println("========================================\n");
}
#endif

// ==== LED制御関数（単色LED）====
void setLEDMode(LEDMode mode) {
  if (currentLEDMode == mode) return;
  currentLEDMode = mode;
  lastLEDUpdate = millis();
  breathingValue = 0;
  breathingUp = true;
  blinkState = false;

  // 即座に状態を反映
  switch (mode) {
    case LED_OFF:
      ledcWrite(PIN_LED, 0);    // 0=OFF (GPIO LOW)
      break;
    case LED_ON:
      ledcWrite(PIN_LED, 255);  // 255=ON (GPIO HIGH)
      break;
    case LED_BREATHING:
      breathingValue = 50;
      ledcWrite(PIN_LED, breathingValue);
      break;
    case LED_BLINKING:
      blinkState = true;
      ledcWrite(PIN_LED, 255);  // 点灯から開始
      break;
  }
}

// loop()から呼ぶLED更新
void updateLEDAnimation() {
  unsigned long now = millis();

  if (currentLEDMode == LED_BREATHING) {
    // ふわふわ: 30ms毎に明るさ変更
    if (now - lastLEDUpdate > 30) {
      lastLEDUpdate = now;

      if (breathingUp) {
        breathingValue += 5;
        if (breathingValue >= 255) {
          breathingValue = 255;
          breathingUp = false;
        }
      } else {
        breathingValue -= 5;
        if (breathingValue <= 50) {  // 完全に消さず、50で折り返し
          breathingValue = 50;
          breathingUp = true;
        }
      }

      ledcWrite(PIN_LED, breathingValue);  // PWM値そのまま
    }
  }
  else if (currentLEDMode == LED_BLINKING) {
    // 点滅: 300ms毎にON/OFF
    if (now - lastLEDUpdate > 300) {
      lastLEDUpdate = now;
      blinkState = !blinkState;
      ledcWrite(PIN_LED, blinkState ? 255 : 0);  // 255=ON, 0=OFF
    }
  }
}

// ==== 会話履歴に追加 ====
void addToHistory(const String& role, const String& content) {
  if (historyCount >= MAX_HISTORY * 2) {
    for (int i = 0; i < historyCount - 2; i++) {
      conversationHistory[i] = conversationHistory[i + 2];
    }
    historyCount -= 2;
  }

  conversationHistory[historyCount].role = role;
  conversationHistory[historyCount].content = content;
  historyCount++;

  Serial.printf("💾 Added to history [%s]: %s\n", role.c_str(), content.c_str());
}

// ==== mono → stereo 変換（音量調整付き） ====
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  for (size_t i = 0; i < samples; i++) {
    int16_t sample = (int16_t)(mono[i] * VOLUME);
    stereo[2*i]     = sample;
    stereo[2*i + 1] = sample;
  }
}

// ==== I2S 録音設定 (STT) ====
void setupI2SRecord() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE_STT,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = true,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_DATA
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ i2s_driver_install failed: %d\n", err);
    // エラー時はLED点灯
  }
  err = i2s_set_pin(I2S_NUM_0, &pins);
  if (err != ESP_OK) {
    Serial.printf("❌ i2s_set_pin failed: %d\n", err);
    // エラー時はLED点灯
  }
  i2s_start(I2S_NUM_0);
}

// ==== I2S 再生設定 (TTS) ====
void setupI2SPlay() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  delay(10);

  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE_TTS,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = 32,    // 内部RAM制約のため32に維持（32KB = 約0.34秒）
    .dma_buf_len = 1024,
    .use_apll = true,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_WS,
    .data_out_num = PIN_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_set_clk(I2S_NUM_1, SAMPLE_RATE_TTS, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);

  digitalWrite(PIN_AMP_SD, HIGH);
  delay(10);
}

// ==== チャンク管理用グローバル変数 ====
static int g_currentChunkSize = -1;
static int g_bytesReadFromChunk = 0;

// ==== HTTPチャンクサイズ読み取り ====
int readChunkSize(WiFiClientSecure& client) {
  const int MAX_RETRIES = 3;

  for (int retry = 0; retry < MAX_RETRIES; retry++) {
    String line = "";
    unsigned long startTime = millis();

    while (client.connected() && (millis() - startTime < 5000)) {
      if (client.available()) {
        char c = client.read();
        if (c == '\n') {
          break;
        } else if (c != '\r') {
          line += c;
        }
      } else {
        delay(1);
      }
    }

    if (line.length() == 0) {
      Serial.printf("[CHUNK] Read empty line (retry %d/%d)\n", retry + 1, MAX_RETRIES);
      if (retry < MAX_RETRIES - 1) {
        delay(100);
        continue;
      }
      return -1;
    }

    int chunkSize = 0;
    bool validHex = false;
    for (int i = 0; i < line.length(); i++) {
      char c = line.charAt(i);
      if (c >= '0' && c <= '9') {
        chunkSize = chunkSize * 16 + (c - '0');
        validHex = true;
      } else if (c >= 'a' && c <= 'f') {
        chunkSize = chunkSize * 16 + (c - 'a' + 10);
        validHex = true;
      } else if (c >= 'A' && c <= 'F') {
        chunkSize = chunkSize * 16 + (c - 'A' + 10);
        validHex = true;
      } else {
        break;
      }
    }

    if (!validHex) {
      Serial.printf("[CHUNK] Invalid hex line: '%s' (retry %d/%d)\n", line.c_str(), retry + 1, MAX_RETRIES);
      if (retry < MAX_RETRIES - 1) {
        delay(100);
        continue;
      }
      return -1;
    }

    Serial.printf("[CHUNK] Size: %d (0x%s)\n", chunkSize, line.c_str());
    return chunkSize;
  }

  return -1;
}

// ==== チャンク境界を超えてデータを読む ====
size_t readBytesAcrossChunks(WiFiClientSecure& client, uint8_t* buffer, size_t length) {
  size_t totalRead = 0;
  unsigned long startTime = millis();
  const unsigned long TIMEOUT_MS = 10000;

  while (totalRead < length) {
    if (millis() - startTime > TIMEOUT_MS) {
      Serial.printf("[READ] Timeout after %d bytes\n", totalRead);
      return totalRead;
    }

    if (g_currentChunkSize == -1 || g_bytesReadFromChunk >= g_currentChunkSize) {
      if (g_currentChunkSize > 0) {
        while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) {
          delay(1);
        }
        client.read();
        client.read();
      }

      g_currentChunkSize = readChunkSize(client);
      g_bytesReadFromChunk = 0;

      if (g_currentChunkSize == 0) {
        return totalRead;
      } else if (g_currentChunkSize < 0) {
        Serial.println("[READ] Chunk read error");
        return totalRead;
      }
    }

    int remainingInChunk = g_currentChunkSize - g_bytesReadFromChunk;
    int toRead = min((int)(length - totalRead), remainingInChunk);

    while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) {
      delay(1);
    }

    if (!client.connected() && !client.available()) {
      Serial.println("[READ] Connection closed");
      return totalRead;
    }

    int available = client.available();
    if (available > 0) {
      int actualRead = min(toRead, available);
      size_t read = client.readBytes(buffer + totalRead, actualRead);
      totalRead += read;
      g_bytesReadFromChunk += read;
    }
  }

  return totalRead;
}

// ==== バイナリプロトコル: メタデータ処理 (type=0x01) ====
void processMetadata(WiFiClientSecure& client, uint32_t length) {
  if (length == 0 || length > 4096) {
    Serial.printf("[META] Invalid length: %d\n", length);
    return;
  }

  char* jsonBuf = (char*)malloc(length + 1);
  if (!jsonBuf) {
    Serial.println("[META] malloc failed");
    return;
  }

  size_t bytesRead = readBytesAcrossChunks(client, (uint8_t*)jsonBuf, length);
  jsonBuf[bytesRead] = '\0';

  if (bytesRead != length) {
    Serial.printf("[META] Read mismatch: expected=%d, got=%d\n", length, bytesRead);
    free(jsonBuf);
    return;
  }

  String json = String(jsonBuf);
  Serial.printf("[META] %s\n", jsonBuf);

  if (json.indexOf("\"event\":\"segment\"") >= 0) {
    int p = json.indexOf("\"text\":\"");
    if (p >= 0) {
      p += 8;
      int e = json.indexOf("\"", p);
      if (e >= 0) {
        String segmentText = json.substring(p, e);
        responseText += segmentText;
        Serial.printf("[SEGMENT] Text: %s\n", segmentText.c_str());
      }
    }
    int idPos = json.indexOf("\"id\":");
    if (idPos >= 0) {
      idPos += 5;
      curSegmentId = json.substring(idPos, json.indexOf(",", idPos)).toInt();
    }
  }

  if (json.indexOf("\"event\":\"tts_start\"") >= 0) {
    int sizePos = json.indexOf("\"size\":");
    if (sizePos >= 0) {
      sizePos += 7;
      currentPcmSize = json.substring(sizePos, json.indexOf("}", sizePos)).toInt();
      Serial.printf("[TTS_START] id=%d, size=%d\n", curSegmentId, currentPcmSize);
    }
  }

  free(jsonBuf);
}

// ==== バイナリプロトコル: PCMデータ処理 (type=0x02) - ストリーミング版 ====
void processPCM(WiFiClientSecure& client, uint32_t length) {
  Serial.printf("[PCM] Streaming %d bytes\n", length);
#if DEBUG_MEMORY
  printMemoryStatus("Before PCM Processing");
#endif

  // ストリーミング再生用のバッファ（64KB）
  const size_t STREAM_CHUNK_SIZE = 65536;  // 64KB = 約0.68秒分の音声
  uint32_t remaining = length;
  uint32_t totalPlayed = 0;

  while (remaining > 0) {
    // LED演出更新（再生中の点滅）
    updateLEDAnimation();

    // 今回読むサイズ
    uint32_t chunkSize = (remaining > STREAM_CHUNK_SIZE) ? STREAM_CHUNK_SIZE : remaining;

    // モノラルPCMバッファ確保（PSRAM優先、v1.1パターン）
    uint8_t* pcmData = (uint8_t*)ps_malloc(chunkSize);  // PSRAM明示
    if (!pcmData) {
      pcmData = (uint8_t*)malloc(chunkSize);  // フォールバック
    }
#if DEBUG_MEMORY
    Serial.printf("[ALLOC] pcmData: %d bytes at %p\n", chunkSize, pcmData);
#endif
    if (!pcmData) {
      Serial.printf("[PCM] malloc failed for chunk! Skipping remaining %d bytes\n", remaining);
      // 残りを読み捨て
      uint8_t dummy[512];
      while (remaining > 0) {
        uint32_t toRead = (remaining > 512) ? 512 : remaining;
        size_t read = readBytesAcrossChunks(client, dummy, toRead);
        if (read == 0) break;
        remaining -= read;
      }
      return;
    }

    // チャンク読み込み
    size_t bytesRead = readBytesAcrossChunks(client, pcmData, chunkSize);
    if (bytesRead != chunkSize) {
      Serial.printf("[PCM] Read mismatch in chunk: expected=%d, got=%d\n", chunkSize, bytesRead);
      free(pcmData);
      break;
    }

    // ステレオバッファ確保
    size_t samples = bytesRead / 2;
    size_t stereoBytes = samples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
#if DEBUG_MEMORY
    Serial.printf("[ALLOC] stereo: %d bytes at %p\n", stereoBytes, stereo);
#endif
    if (!stereo) {
      Serial.println("[PCM] stereo malloc failed for chunk!");
      free(pcmData);
      break;
    }

    // 変換
    monoToStereo((int16_t*)pcmData, stereo, samples);
    free(pcmData);

    // 即座に再生
    size_t written = 0;
    i2s_write(I2S_NUM_1, (uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
    free(stereo);

    totalPlayed += written;
    remaining -= bytesRead;

    // 進捗表示（デバッグ用）
    if (totalPlayed % (STREAM_CHUNK_SIZE * 4) == 0) {
      Serial.printf("[PCM] Streaming... played %d/%d bytes\n", totalPlayed, length * 2);
    }
  }

  Serial.printf("[PCM] Streaming complete: %d bytes total\n", totalPlayed);
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";

  // 処理中状態は省略（LED更新を最小化）
  // setLEDState(LED_PROCESSING);

  if (isRecording) {
    ws.disconnect();
    isRecording = false;
    Serial.println("🛑 Stopped recording for TTS");
  }

  i2s_driver_uninstall(I2S_NUM_0);
  setupI2SPlay();

  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect(LAMBDA_HOST, 443)) {
    Serial.println("❌ connect failed");
    setLEDMode(LED_OFF);  // エラー時は消灯
    return;
  }

  String messagesJson = "[";
  for (int i = 0; i < historyCount; i++) {
    if (i > 0) messagesJson += ",";
    messagesJson += "{\"role\":\"" + conversationHistory[i].role + "\",";
    messagesJson += "\"content\":\"" + conversationHistory[i].content + "\"}";
  }
  if (historyCount > 0) messagesJson += ",";
  messagesJson += "{\"role\":\"user\",\"content\":\"" + text + "\"}";
  messagesJson += "]";

  String payload =
    "{\"model\":\"Google\",\"voice\":\"nova\","
    "\"messages\":" + messagesJson + "}";

  Serial.printf("📝 History count: %d\n", historyCount);

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  client.print(req);

  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.println("📨 BINARY STREAM START (Chunked)");

  g_currentChunkSize = -1;
  g_bytesReadFromChunk = 0;

  // TTS開始 = 再生中はLED点滅
  setLEDMode(LED_BLINKING);

  while (client.connected() || client.available()) {
    uint8_t header[5];
    size_t read = readBytesAcrossChunks(client, header, 5);

    if (read == 0) {
      Serial.println("🏁 BINARY STREAM END");
      break;
    }

    if (read != 5) {
      Serial.printf("[BINARY] Header incomplete: %d/5 bytes\n", read);
      break;
    }

    uint8_t type = header[0];
    uint32_t length = (header[1]) | (header[2] << 8) | (header[3] << 16) | (header[4] << 24);

    Serial.printf("[BINARY] type=0x%02X, length=%d\n", type, length);

    if (type == 0x01) {
      processMetadata(client, length);
    } else if (type == 0x02) {
      processPCM(client, length);
    } else {
      Serial.printf("[BINARY] Unknown type: 0x%02X, skip %d bytes\n", type, length);
      uint8_t* dummy = (uint8_t*)malloc(length);
      if (dummy) {
        readBytesAcrossChunks(client, dummy, length);
        free(dummy);
      }
    }
  }

  Serial.println("🔊 Playback complete");

  delay(2000);
  Serial.println("🔊 Buffer flushed");

  addToHistory("user", text);
  if (responseText.length() > 0) {
    addToHistory("assistant", responseText);
  }

  i2s_stop(I2S_NUM_1);
  i2s_driver_uninstall(I2S_NUM_1);

  delay(150);
  startSTTRecording();
}

// ==== Soniox WebSocketイベント ====
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ Connected to Soniox!");
      {
        String startMsg =
          "{\"api_key\":\"" + sonioxKey + "\","
          "\"model\":\"stt-rt-preview\","
          "\"audio_format\":\"pcm_s16le\","
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox");
        // 録音開始 = LEDふわふわ
        setLEDMode(LED_BREATHING);
      }
      isRecording = true;
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;
      if (msg.indexOf("\"tokens\"") >= 0) {
        String newText = "";
        int pos = 0;
        while ((pos = msg.indexOf("\"text\":\"", pos)) >= 0) {
          pos += 8;
          int end = msg.indexOf("\"", pos);
          if (end < 0) break;
          String token = msg.substring(pos, end);
          if (token != "\\u003cend\\u003e") newText += token;
        }

        if (newText.length() > 0) {
          if (newText.startsWith(partialText)) {
            partialText = newText;
          } else {
            partialText = newText;
          }
          lastPartialMs = millis();
          armed = true;
          Serial.println("📝 " + partialText);
        }
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("✅ Soniox disconnected");
      isRecording = false;
      break;

    case WStype_BIN:
    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;
  }
}

// ==== STT録音開始 ====
void startSTTRecording() {
  Serial.println("🎙️ Starting STT recording...");

  // 録音準備中はLED点灯（WebSocket接続後にふわふわに変わる）
  setLEDMode(LED_ON);

  setupI2SRecord();

  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);

  partialText = "";
  lastFinalText = "";
  armed = false;
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(500);
  Serial.println("\n🚀 ToyTalk Conversation v1.3 (STT→LLM→TTS with Streaming Chunk Playback)");

  // LED初期化（PWM使用 - 新API）
  ledcAttach(PIN_LED, LED_FREQ, LED_RESOLUTION);
  setLEDMode(LED_ON);  // 起動中は点灯

  // ボタン初期化
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

  // WiFi接続（完全リセットしてから接続）
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.disconnect(true);  // 前の接続情報をクリア
  delay(1000);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.println("WiFi.begin() called");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n❌ WiFi connection failed!");
    Serial.printf("WiFi status: %d\n", WiFi.status());
    return;
  }

  // WiFi接続完了後、LEDは点灯状態維持（次のSTT開始まで）
  // setLEDMode(LED_ON); は startSTTRecording() で設定される

  // Soniox temp key取得
  HTTPClient http;
  http.begin(SONIOX_LAMBDA_URL);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("❌ HTTP fail %d\n", code);
    return;
  }
  String resp = http.getString();
  http.end();

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    Serial.println("⚠️ JSON parse error");
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key obtained");

  // メモリ状態確認（初期状態）
#if DEBUG_MEMORY
  printMemoryStatus("After WiFi & Soniox Init");
#endif

  // I2S再生設定
  setupI2SPlay();

  // STT録音開始
  delay(1000);
  startSTTRecording();
}

// ==== LOOP ====
void loop() {
  ws.loop();

  // LED演出更新
  updateLEDAnimation();

  // ボタンチェック（デバウンス処理付き）
  int reading = digitalRead(PIN_BUTTON);

  // 読み取り値が変化したらデバウンスタイマーをリセット
  if (reading != lastButtonReading) {
    lastDebounceTime = millis();
  }

  // デバウンス時間経過後、安定した状態を確定
  if ((millis() - lastDebounceTime) > debounceDelay) {
    // 状態が変化した場合のみ処理
    if (reading != buttonState) {
      buttonState = reading;

      // HIGHからLOWへの遷移（ボタン押下）のみ検知
      if (buttonState == LOW) {
        Serial.println("🔘 Button pressed");
        // ここに将来の拡張処理を追加
      }
    }
  }

  lastButtonReading = reading;

  // 録音データをWebSocketに送信
  if (isRecording && WiFi.status() == WL_CONNECTED && ws.isConnected()) {
    static uint32_t lastSend = 0;
    if (millis() - lastSend > 5) {
      int32_t raw[512];
      int16_t pcm[512];
      size_t n = 0;
      i2s_read(I2S_NUM_0, (void*)raw, sizeof(raw), &n, portMAX_DELAY);
      int samples = n / sizeof(int32_t);
      for (int i = 0; i < samples; i++) {
        pcm[i] = (int16_t)(raw[i] >> 14);
      }
      ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      lastSend = millis();
    }
  }

  // 無音検出 → 確定文出力
  if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
    if (partialText != lastFinalText) {
      Serial.println("\n✅ 確定文（無音検出）:");
      Serial.println(partialText);
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    armed = false;
    partialText = "";
  }
}
