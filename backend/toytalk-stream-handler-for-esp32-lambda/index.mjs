  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY
  import OpenAI from "openai";
  import { createHash } from "node:crypto";

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ---- チューニング定数 ----
  const HEAD_MIN_CHARS = 24;      // 今回は使わない（ヘッドTTS無効）
  const SEG_MAX_CHARS  = 48;
  const TTS_FORMAT     = "pcm";
  const VOICE_DEFAULT  = "alloy";
  const DEBUG          = false;
  const DEBUG_TIME     = process.env.DEBUG_TIME === "true";

  const send  = (res, ev, data)=>res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
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
      ttsModel:  "gpt-4o-mini-tts",
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
    // 置き石
    NijiVoice: {
      llmVendor: "openai",
      llmModel:  "gpt-4.1-mini",
      ttsVendor: "",       // 後で変更
      ttsModel:  "",
    },
  };



  // 文末かどうか（簡易）
  function endsWithSentence(s) {
    return /[。！？!?]\s*$/.test(s);
  }

// OpenAI TTS → base64
async function ttsToBase64OpenAI(text, voice, ttsModel) {
  try {
    const tts = await openai.audio.speech.create({
      model: ttsModel,
      input: text,
      voice,
      // 🔽 ここを format ではなく response_format に変更
      response_format: "pcm"
    });

    const buf = Buffer.from(await tts.arrayBuffer());
    console.log(`[TTS] PCM size: ${buf.length} bytes`);

    // 🔽 先頭が MP3 だったら（FF F3 / ID3 など）フォールバックで WAV 再取得
    if (buf[0] === 0xFF && (buf[1] === 0xF3 || buf[1] === 0xFB || buf[0] === 0x49)) {
      console.warn("[TTS] PCM not returned, retrying as WAV");
      const tts2 = await openai.audio.speech.create({
        model: ttsModel.replace("mini", "tts"), // miniで失敗したら大モデルに切替
        input: text,
        voice,
        format: "wav"
      });
      const buf2 = Buffer.from(await tts2.arrayBuffer());
      return buf2.toString("base64");
    }

    // ここまで来たら本物のPCM
    return buf.toString("base64");

  } catch (err) {
    console.error("[TTS] OpenAI PCM fetch failed:", err);
    throw err;
  }
}



  // PCM16 (LINEAR16) を WAV へラップして base64 を返す
  function pcm16ToWavBase64(pcmB64, sampleRate = 24000, channels = 1) {
    // 入力: Google TTS の LINEAR16 base64（LE, signed）
    let pcm = Buffer.from(pcmB64, "base64");

    const bytesPerSample = 2;
    const totalSamples = pcm.length / bytesPerSample;

    // --- DCオフセット除去（平均値を0に寄せる） ---
    let sum = 0;
    for (let i = 0; i < totalSamples; i++) sum += pcm.readInt16LE(i * 2);
    const mean = sum / totalSamples;
    for (let i = 0; i < totalSamples; i++) {
      const v = pcm.readInt16LE(i * 2) - mean;
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
    }

    // --- 先頭/末尾 をハニング窓でフェード（Google TTSの冒頭クリック音潰し） ---
    const fadeMs = 12;
    const fadeSamples = Math.min(
      Math.floor(sampleRate * fadeMs / 1000),
      Math.floor(totalSamples / 4)
    );
    for (let i = 0; i < fadeSamples; i++) {
      const wIn  = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));                 // 0→1
      const wOut = 0.5 * (1 - Math.cos(Math.PI * (fadeSamples - i) / fadeSamples)); // 1→0
      // in
      const vi = pcm.readInt16LE(i * 2);
      pcm.writeInt16LE(Math.round(vi * wIn), i * 2);
      // out
      const idx = (totalSamples - 1 - i) * 2;
      const vo = pcm.readInt16LE(idx);
      pcm.writeInt16LE(Math.round(vo * wOut), idx);
    }

    // --- 先頭の無音パッド（Google TTSの冒頭クリック音吸収）---
    const padHeadMs = 40;
    const padSamples = Math.max(1, Math.floor(sampleRate * padHeadMs / 1000));
    const pad = Buffer.alloc(padSamples * bytesPerSample, 0);
    pcm = Buffer.concat([pad, pcm]);

    // --- WAV ラップ ---
    const byteRate   = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const dataSize   = pcm.length;
    const headerSize = 44;
    const buf = Buffer.alloc(headerSize + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    pcm.copy(buf, 44);
    return buf.toString("base64");
  }

  function resolveGoogleTtsFromBody(body) {
    const t = body?.tts || {};
    // Googleのvoice形式だけ通す（alloy等が入っても安全に既定へ）
    const cand = t.voice || body?.voice;
    const isGoogleVoice = typeof cand === "string" && /^[a-z]{2}-[A-Z]{2}-/.test(cand);
    const voiceName = isGoogleVoice ? cand : "ja-JP-Neural2-B";

    return {
     voiceName,
     // ← 未指定は "入れない"（= undefined を返す）
     speakingRate: (typeof t.speakingRate === "number") ? t.speakingRate : undefined,
     pitch:        (typeof t.pitch        === "number") ? t.pitch        : undefined,
     sampleRateHertz: (typeof t.sampleRateHertz === "number") ? t.sampleRateHertz : undefined,
      audioEncoding: "LINEAR16", // ★ WAV固定（LINEAR16→WAVラップ）
    };
  }

  // Google Cloud Text-to-Speech (API Key) → base64(WAV)
  async function ttsToBase64Google(
    text,
    {
      voiceName,
      speakingRate = 1.3,
      pitch = 3.0,
      sampleRateHertz = 24000,
      audioEncoding = "LINEAR16", // ← WAVに包む前提
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
    // json.audioContent は PCM16 (raw)。→ WAV に包んで返す
    console.log("TTS Content-Type:", tts.headers.get("content-type"));
    return pcm16ToWavBase64(json.audioContent, sampleRateHertz, 1);
    console.log("TTS Content-Type:", tts.headers.get("content-type"));
  }


  // Gemini 用の voice 解決（アプリから "Lede"/"Puck" などが来る想定）
  function resolveGeminiTtsFromBody(body, cfg) {
    const t = body?.tts || {};
    const cand = t.voice || body?.voice;
    const looksGoogle = typeof cand === "string" && /^[a-z]{2}-[A-Z]{2}-/.test(cand);
    const looksGemini = typeof cand === "string"
      && /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(cand)   // 英数/アンダースコア/ハイフン可
      && !looksGoogle;                                 // Google 形式は除外
    const voiceName = looksGemini ? cand : "leda";     // 既定は Kore（Lede/Puck 等でもOK）
    return { model: cfg.ttsModel, voiceName };
  }

  // Gemini Speech Generation → base64(WAV)（APIキーは GOOGLE_API_KEY を共用）
  async function ttsToBase64Gemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
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
    // 24kHz/mono PCM16 → 既存の WAV ラッパで包む
    return pcm16ToWavBase64(b64Pcm, 24000, 1);
  }


  
  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("text/event-stream");

    const body    = event.body ? JSON.parse(event.body) : {};
    const voice   = body.voice ?? VOICE_DEFAULT;
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const rawModel = typeof body.model === "string" ? body.model : undefined;
    const modelKey = normalizeModelKey(rawModel) ?? MODEL_DEFAULT;
    const cfg      = MODEL_TABLE[modelKey] ?? MODEL_TABLE[MODEL_DEFAULT];

    function normalizeModelKey(k) {
      if (!k) return undefined;
      const s = String(k).toLowerCase();
      if (s.includes("openai"))  return "OpenAI";
      if (s.includes("google"))  return "Google";
      if (s.includes("gemini"))  return "Gemini";
      if (s.includes("niji"))    return "NijiVoice";
      return undefined; // 不明ならデフォルトにフォールバック
    }


    // クライアント側の計測・デバッグ用に「採用モデル」を通知
    send(res, "mark", { k: "model", v: modelKey });
    send(res, "mark", { k: "llm_vendor", v: cfg.llmVendor });
    send(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      send(res, "ping", { t: Date.now() });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      send(res, "mark", { k: "llm_start", t: Date.now() });
    }

    // システムプロンプトを追加（会話履歴がある場合は挨拶を省略）
    const systemPrompt = {
      role: "system",
      content: "あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。"
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

      // 画面用の確定テキスト
      send(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        send(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      // 音声チャンク（textは載せない）
      try {
        let b64, fmt;
        if (cfg.ttsVendor === "openai") {
          b64 = await ttsToBase64OpenAI(t, voice, cfg.ttsModel);
          fmt = TTS_FORMAT;
        } else if (cfg.ttsVendor === "google") {
          const g = resolveGoogleTtsFromBody(body);
          const w = await ttsToBase64Google(t, g);
          b64 = w;
          fmt = "wav";
        } else if (cfg.ttsVendor === "gemini") {
          const g = resolveGeminiTtsFromBody(body, cfg);
          b64 = await ttsToBase64Gemini(t, g);
          fmt = "wav";
        } else {
          throw new Error("Unknown ttsVendor");
        }
        send(res, "tts", { id: segSeq, format: fmt, b64 });
        console.log(`[Lambda] id=${segSeq}, b64.length=${b64?.length ?? 0}, text="${t}"`);
      } catch (e) {
        send(res, "error", { message: `TTS failed: ${e?.message || e}` });
      }
    }

    // ---- LLM ストリーム処理（共通インターフェース）----
    try {
      // ---- LLM ストリーム処理（共通）----
      for await (const delta of llmStream) {
        textAll += delta;
        buf     += delta;
        if (DEBUG) send(res, "llm_token", { token: delta });
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
      send(res, "done", {});
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      send(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
