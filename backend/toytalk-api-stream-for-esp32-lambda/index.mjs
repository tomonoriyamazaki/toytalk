  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY
  import OpenAI from "openai";
  import { createHash } from "node:crypto";

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
    // LLM: OpenAI / TTS: OpenAI
    OpenAI: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "openai",
      ttsModel:  "gpt-4o-mini-tts-2025-03-20",
    },
    // LLM: OpenAI / TTS: Google Cloud Text-to-Speech
    Google: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "google",
      ttsModel:  "google-tts",
    },
    // LLM: OpenAI / TTS: Gemini Speech Generation
    Gemini: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "gemini",
      ttsModel:  "gemini-2.5-flash-preview-tts",   // 名称は任意（識別用）
    },
    // LLM: OpenAI / TTS: ElevenLabs
    ElevenLabs: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "elevenlabs",
      ttsModel:  "eleven_turbo_v2_5",
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


  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("application/octet-stream");

    const body    = event.body ? JSON.parse(event.body) : {};
    const voice   = body.voice ?? VOICE_DEFAULT;
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const rawModel = typeof body.model === "string" ? body.model : undefined;
    const modelKey = normalizeModelKey(rawModel) ?? MODEL_DEFAULT;
    const cfg      = MODEL_TABLE[modelKey] ?? MODEL_TABLE[MODEL_DEFAULT];

    function normalizeModelKey(k) {
      if (!k) return undefined;
      const s = String(k).toLowerCase();
      if (s.includes("openai"))      return "OpenAI";
      if (s.includes("google"))      return "Google";
      if (s.includes("gemini"))      return "Gemini";
      if (s.includes("elevenlabs"))  return "ElevenLabs";
      return undefined; // 不明ならデフォルトにフォールバック
    }


    // クライアント側の計測・デバッグ用に「採用モデル」を通知
    sendMeta(res, "mark", { k: "model", v: modelKey });
    sendMeta(res, "mark", { k: "llm_vendor", v: cfg.llmVendor });
    sendMeta(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      sendMeta(res, "ping", { t: Date.now() });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      sendMeta(res, "mark", { k: "llm_start", t: Date.now() });
    }

    // システムプロンプトを追加（会話履歴がある場合は挨拶を省略）
    const systemPrompt = {
      role: "system",
      content: "あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。漢字は最小限にして、ひらがな多めで答えてください。"
    };
    const messagesWithSystem = [systemPrompt, ...messages];

    let llmStream;
    if (cfg.llmVendor === "openai") {
      const llm = await openai.chat.completions.create({
        model: cfg.llmModel,
        temperature: 0.7,
        stream: true,
        messages: messagesWithSystem,
      });
      llmStream = (async function* () {
        for await (const chunk of llm) {
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
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      sendMeta(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
