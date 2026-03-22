  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

  const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const DEVICES_TABLE    = "toytalker-devices";
  const VOICES_TABLE     = "toytalker-voices";
  const CHARACTERS_TABLE = "toytalker-characters";
  const CHAT_LOGS_TABLE  = "toytalker-chat-logs";

  async function saveLog(item) {
    try {
      await ddb.send(new PutCommand({ TableName: CHAT_LOGS_TABLE, Item: item }));
    } catch (e) {
      console.error("[saveLog] error:", e);
    }
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ---- チューニング定数 ----
  const HEAD_MIN_CHARS = 24;      // 今回は使わない（ヘッドTTS無効）
  const SEG_MAX_CHARS  = 100;     // 文末で自然に区切るため増加（安全網として残す）
  const TTS_FORMAT     = "pcm";
  const VOICE_DEFAULT  = "alloy";
  const DEBUG          = false;
  const DEBUG_TIME     = process.env.DEBUG_TIME === "true";

  // Binary protocol helpers
  // Send JSON metadata (type=0x01)
  const sendMeta = (res, ev, data) => {
    const json = JSON.stringify({ event: ev, ...data });
    const buf = Buffer.from(json, "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0x01, 0);           // type: metadata
    header.writeUInt32LE(buf.length, 1);  // length
    res.write(header);
    res.write(buf);
  };

  // Send binary PCM data (type=0x02)
  const sendPCM = (res, pcmBuffer) => {
    const header = Buffer.alloc(5);
    header.writeUInt8(0x02, 0);              // type: PCM audio
    header.writeUInt32LE(pcmBuffer.length, 1); // length
    res.write(header);
    res.write(pcmBuffer);
  };

  const sha1  = (s)=>createHash("sha1").update(s).digest("hex");

  // ---- 選択モデル定義（まずは OpenAI 固定運用）----
  const MODEL_DEFAULT = "OpenAI";
  /** 将来の拡張用にテーブル化しておく（今は OpenAI だけ使う） */
  const MODEL_TABLE = {
    OpenAI: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "openai",
      ttsModel:  "gpt-4o-mini-tts-2025-03-20",
    },
    Google: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "google",
      ttsModel:  "google-tts",
    },
    Gemini: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "gemini",
      ttsModel:  "gemini-2.5-flash-preview-tts",
    },
    ElevenLabs: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "elevenlabs",
      ttsModel:  "eleven_turbo_v2_5",
    },
    FishAudio: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "fishaudio",
      ttsModel:  "fishaudio",
    },
  };



  // 文末かどうか（簡易）
  function endsWithSentence(s) {
    return /[。！？!?]\s*$/.test(s);
  }

// OpenAI TTS → Buffer (raw PCM)
async function ttsBufferOpenAI(text, voice, ttsModel) {
  try {
    const tts = await openai.audio.speech.create({
      model: ttsModel,
      input: text,
      voice,
      response_format: "pcm"
    });

    const buf = Buffer.from(await tts.arrayBuffer());
    console.log(`[TTS] PCM size: ${buf.length} bytes`);

    // 先頭が MP3 だったらフォールバックで WAV 再取得
    if (buf[0] === 0xFF && (buf[1] === 0xF3 || buf[1] === 0xFB || buf[0] === 0x49)) {
      console.warn("[TTS] PCM not returned, retrying as WAV");
      const tts2 = await openai.audio.speech.create({
        model: ttsModel.replace("mini", "tts"),
        input: text,
        voice,
        format: "wav"
      });
      return Buffer.from(await tts2.arrayBuffer());
    }

    // 本物のPCM Bufferを返す
    // デバッグ: 最初の16バイトを確認
    const head = buf.slice(0, 16);
    console.log(`[TTS OpenAI] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS OpenAI] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return buf;

  } catch (err) {
    console.error("[TTS] OpenAI PCM fetch failed:", err);
    throw err;
  }
}

  // Google Cloud Text-to-Speech (API Key) → Buffer (raw PCM)
  async function ttsBufferGoogle(
    text,
    {
      voiceName,
      speakingRate = 1.2,
      pitch = 3.0,
      sampleRateHertz = 24000,
      audioEncoding = "LINEAR16",
    } = {}
  ) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY is not set");
    // 例: "ja-JP-Neural2-B" → "ja-JP"
    const parts = String(voiceName).split("-");
    const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";

    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: voiceName },
          audioConfig: {
            audioEncoding,
            speakingRate,
            pitch,
            sampleRateHertz,
          },
        }),
      }
    );
    const json = await resp.json();
    if (!resp.ok) {
      const msg = json?.error?.message || "Google TTS failed";
      throw new Error(msg);
    }
    // json.audioContent は LINEAR16 (base64) → 生のBufferに変換
    const pcmBuffer = Buffer.from(json.audioContent, "base64");
    console.log(`[TTS Google] PCM size: ${pcmBuffer.length} bytes`);

    // Google TTS特有の冒頭クリック音対策: フェードイン処理
    const fadeMs = 20;  // 20ミリ秒
    const fadeSamples = Math.floor(sampleRateHertz * fadeMs / 1000);
    for (let i = 0; i < fadeSamples && i * 2 < pcmBuffer.length; i++) {
      const fade = i / fadeSamples;  // 0→1
      const sample = pcmBuffer.readInt16LE(i * 2);
      pcmBuffer.writeInt16LE(Math.round(sample * fade), i * 2);
    }

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Google] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Google] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }


  // Gemini Speech Generation → Buffer (raw PCM)（APIキーは GOOGLE_API_KEY を共用）
  async function ttsBufferGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY is not set");
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
          model,
        }),
      }
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
    const b64Pcm = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    if (!b64Pcm) throw new Error("Gemini TTS: empty audio");

    // 24kHz/mono PCM16 base64 → 生のBufferに変換
    const pcmBuffer = Buffer.from(b64Pcm, "base64");
    console.log(`[TTS Gemini] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Gemini] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Gemini] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }

  // ElevenLabs TTS → Buffer (raw PCM)
  async function ttsBufferElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`ElevenLabs TTS failed: ${resp.status} ${errorText}`);
    }

    // レスポンスヘッダーを確認
    const contentType = resp.headers.get('content-type');
    console.log(`[TTS ElevenLabs] Content-Type: ${contentType}`);

    // PCMバイナリデータを直接返す
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS ElevenLabs] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS ElevenLabs] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS ElevenLabs] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }


  // FishAudio TTS → Buffer (raw PCM via MP3 decode is not feasible on Lambda;
  // FishAudio supports pcm output via format param)
  async function ttsBufferFishAudio(text, { referenceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.FISHAUDIO_API_KEY;
    if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
    const resp = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`FishAudio TTS failed: ${resp.status} ${errorText}`);
    }
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS FishAudio] PCM size: ${pcmBuffer.length} bytes`);
    return pcmBuffer;
  }

  // DynamoDBからdevice_idに紐づくキャラクター＆ボイス設定を解決
  // 解決チェーン: device → character(voice_id + personality_prompt) → voice(provider + vendor_id)
  async function resolveCharacterFromDynamo(deviceId) {
    try {
      const deviceRes = await ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id: deviceId },
      }));
      const device = deviceRes.Item;
      if (!device) return null;

      let voiceId = null;
      let personalityPrompt = null;

      // character_id があればキャラクターテーブルを参照
      if (device.character_id && device.character_id !== "default") {
        const charRes = await ddb.send(new GetCommand({
          TableName: CHARACTERS_TABLE,
          Key: { character_id: device.character_id },
        }));
        if (charRes.Item) {
          voiceId = charRes.Item.voice_id ?? null;
          personalityPrompt = charRes.Item.personality_prompt || null;
        }
      }

      // character_id が未設定またはキャラに voice_id がなければ device.voice_id にフォールバック（後方互換）
      if (!voiceId) voiceId = device.voice_id ?? null;
      if (!voiceId) return null;

      const voiceRes = await ddb.send(new GetCommand({
        TableName: VOICES_TABLE,
        Key: { voice_id: voiceId },
      }));
      if (!voiceRes.Item) return null;

      return {
        provider: voiceRes.Item.provider,
        vendorId: voiceRes.Item.vendor_id,
        personalityPrompt,
      };
    } catch (e) {
      console.error("[DynamoDB] resolveCharacterFromDynamo error:", e);
      return null;
    }
  }

  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("application/octet-stream");

    const body    = event.body ? JSON.parse(event.body) : {};
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const deviceId = typeof body.device_id === "string" ? body.device_id : null;

    // ---- ログ用メタデータ ----
    const sessionId  = typeof body.session_id === "string" ? body.session_id : "unknown";
    const ownerId    = typeof body.owner_id   === "string" ? body.owner_id   : deviceId ?? "unknown";
    const requestAt  = Date.now();
    const userTimestamp = new Date(requestAt).toISOString();

    function normalizeModelKey(k) {
      if (!k) return undefined;
      const s = String(k).toLowerCase();
      if (s.includes("openai"))      return "OpenAI";
      if (s.includes("google"))      return "Google";
      if (s.includes("gemini"))      return "Gemini";
      if (s.includes("elevenlabs"))  return "ElevenLabs";
      if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
      return undefined;
    }

    // device_idがあればDynamoDBからキャラクター＆ボイス設定を取得、なければbodyの値を使う
    let modelKey = normalizeModelKey(body.model) ?? MODEL_DEFAULT;
    let voice    = body.voice ?? VOICE_DEFAULT;
    let personalityPrompt = null;

    if (deviceId) {
      const charConfig = await resolveCharacterFromDynamo(deviceId);
      if (charConfig) {
        modelKey = normalizeModelKey(charConfig.provider) ?? modelKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        console.log(`[DynamoDB] device=${deviceId}, provider=${charConfig.provider}, vendorId=${charConfig.vendorId}, hasPersonality=${!!personalityPrompt}`);
      } else {
        console.log(`[DynamoDB] device=${deviceId} not found or no character set, using defaults`);
      }
    }

    const cfg = MODEL_TABLE[modelKey] ?? MODEL_TABLE[MODEL_DEFAULT];


    // クライアント側の計測・デバッグ用に「採用モデル」を通知
    sendMeta(res, "mark", { k: "model", v: modelKey });
    sendMeta(res, "mark", { k: "llm_vendor", v: cfg.llmVendor });
    sendMeta(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      sendMeta(res, "ping", { t: Date.now() });
    }

    // ---- ユーザーメッセージ保存 ----
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === "user" && sessionId !== "unknown") {
      saveLog({
        "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
        "session_id#timestamp": `session_id#${sessionId}#timestamp#${userTimestamp}`,
        owner_id: ownerId, device_id: deviceId, source: "esp",
        role: "user", content: lastUserMsg.content,
        content_type: "audio", timestamp: userTimestamp, session_id: sessionId,
      });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      sendMeta(res, "mark", { k: "llm_start", t: Date.now() });
    }

    // システムプロンプトを追加（キャラクターの個性 + 共通指示）
    const basePrompt = "あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。漢字は最小限にして、ひらがな多めで答えてください。";
    const systemPrompt = {
      role: "system",
      content: personalityPrompt ? `${personalityPrompt}\n\n${basePrompt}` : basePrompt,
    };
    const messagesWithSystem = [systemPrompt, ...messages];

    let llmStream;
    if (cfg.llmVendor === "openai") {
      const llm = await openai.chat.completions.create({
        model: cfg.llmModel,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
        messages: messagesWithSystem,
      });
      llmStream = (async function* () {
        for await (const chunk of llm) {
          if (chunk.usage) {
            llmTokensIn  = chunk.usage.prompt_tokens     ?? 0;
            llmTokensOut = chunk.usage.completion_tokens ?? 0;
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) yield delta;
        }
      })();
    } else {
    // もし将来 Gemini LLM に切り替えるならここで実装
    const fallback = "（LLM ルート未実装です）";
    llmStream = (async function* () { yield fallback; })();
  }

    // ---- ストリーム状態 ----
    let buf = "";                 // ★ここで1回だけ宣言
    let textAll = "";
    let segSeq = 0;
    let lastSegHash = "";
    let firstTtsMarked = false;
    let ttsChain = Promise.resolve();
    let llmTokensIn = 0, llmTokensOut = 0;
    let ttsInputChars = 0;


    // segment を送る唯一の経路
    async function emitSegment(text, { final=false } = {}) {
      const t = String(text ?? "").trim();
      if (!t) return;
      const h = sha1(t);
      if (h === lastSegHash) return;     // 同一文は再送しない
      lastSegHash = h;
      segSeq += 1;

      // 画面用の確定テキスト（メタデータとして送信）
      sendMeta(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        sendMeta(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      ttsInputChars += t.length;

      // 音声チャンク（生PCMバイナリとして送信）
      try {
        let pcmBuffer;
        if (cfg.ttsVendor === "openai") {
          const voiceName = voice === "default" ? "nova" : voice;
          pcmBuffer = await ttsBufferOpenAI(t, voiceName, cfg.ttsModel);
        } else if (cfg.ttsVendor === "google") {
          const voiceName = voice === "default" ? "ja-JP-Neural2-C" : voice;  // 男性
          pcmBuffer = await ttsBufferGoogle(t, { voiceName });
        } else if (cfg.ttsVendor === "gemini") {
          const voiceName = voice === "default" ? "Kore" : voice;
          pcmBuffer = await ttsBufferGemini(t, { model: cfg.ttsModel, voiceName });
        } else if (cfg.ttsVendor === "elevenlabs") {
          const voiceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;  // Sameno（子供向け）
          pcmBuffer = await ttsBufferElevenLabs(t, { model: cfg.ttsModel, voiceId });
        } else if (cfg.ttsVendor === "fishaudio") {
          const referenceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;
          pcmBuffer = await ttsBufferFishAudio(t, { referenceId });
        } else {
          throw new Error("Unknown ttsVendor");
        }
        // メタデータでチャンク情報を送信
        sendMeta(res, "tts_start", { id: segSeq, size: pcmBuffer.length });
        // PCMバイナリを直接送信
        sendPCM(res, pcmBuffer);
        console.log(`[Lambda] id=${segSeq}, pcm.length=${pcmBuffer.length} bytes, text="${t}"`);
      } catch (e) {
        sendMeta(res, "error", { message: `TTS failed: ${e?.message || e}` });
      }
    }

    // ---- LLM ストリーム処理（共通インターフェース）----
    try {
      // ---- LLM ストリーム処理（共通）----
      for await (const delta of llmStream) {
        textAll += delta;
        buf     += delta;
        if (DEBUG) sendMeta(res, "llm_token", { token: delta });
        if (endsWithSentence(buf) || buf.trim().length >= SEG_MAX_CHARS) {
          const segText = buf.trim();
          buf = "";
          await emitSegment(segText);
        }
      }
      // 残り
      const tail = buf.trim();
      if (tail.length > 0) {
        buf = "";
        await emitSegment(tail, { final: true });
      }
      sendMeta(res, "done", {});

      // ---- アシスタントログ保存 ----
      if (sessionId !== "unknown" && textAll.trim()) {
        const assistantTimestamp = new Date().toISOString();
        saveLog({
          "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
          "session_id#timestamp": `session_id#${sessionId}#timestamp#${assistantTimestamp}`,
          owner_id: ownerId, device_id: deviceId, source: "esp",
          role: "assistant", content: textAll.trim(),
          content_type: "text", timestamp: assistantTimestamp, session_id: sessionId,
          llm_provider: cfg.llmVendor, llm_model: cfg.llmModel,
          llm_tokens_in: llmTokensIn, llm_tokens_out: llmTokensOut,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: "soniox", stt_input_units: null, stt_input_unit_type: null,
          duration_ms: Date.now() - requestAt,
          character_id: null,
          voice_id: voice,
        });
      }
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      sendMeta(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
