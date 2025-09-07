// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: OPENAI_API_KEY
import OpenAI from "openai";
import { createHash } from "node:crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- チューニング定数 ----
const HEAD_MIN_CHARS = 24;      // 今回は使わない（ヘッドTTS無効）
const SEG_MAX_CHARS  = 48;
const TTS_FORMAT     = "wav";
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
  // LLM: OpenAI（据え置き）/ TTS: Google Cloud TTS（Gemini側の音声を使う）
  Gemini: {
    llmVendor: "openai",
    llmModel:  "gpt-4.1-mini",
    ttsVendor: "google",
    ttsModel:  "google-tts",   // 名称は任意（識別用）
  },
  NijiVoice: {
    llmVendor: "openai",
    llmModel:  "gpt-4.1-mini",
    ttsVendor: "google",       // ここは後で差し替え予定なら仮のままでOK
    ttsModel:  "google-tts",
  },
};



// 文末かどうか（簡易）
function endsWithSentence(s) {
  return /[。！？!?]\s*$/.test(s);
}

// OpenAI TTS → base64
async function ttsToBase64OpenAI(text, voice, ttsModel) {
  const tts = await openai.audio.speech.create({
    model: ttsModel,
    input: text,
    voice,
    format: TTS_FORMAT
  });
  const buf = Buffer.from(await tts.arrayBuffer());
  return buf.toString("base64");
}

// PCM16 (LINEAR16) を WAV へラップして base64 を返す
function pcm16ToWavBase64(pcmB64, sampleRate = 24000, channels = 1) {
  const pcm = Buffer.from(pcmB64, "base64");
  const byteRate   = sampleRate * channels * 2; // 16bit = 2 bytes
  const blockAlign = channels * 2;
  const dataSize   = pcm.length;
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);         // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);          // PCM = 1
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);         // bitsPerSample
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf.toString("base64");
}

// Google Cloud Text-to-Speech (API Key) → base64(WAV)
async function ttsToBase64Google(text, voiceName) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  // 例: "ja-JP-Neural2-B" → "ja-JP"
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const sampleRateHertz = 24000; // お好みで（端末互換が良い 24k）

  const resp = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: {
          audioEncoding: "LINEAR16",
          speakingRate: 1.0,
          pitch: 0.0,
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
  return pcm16ToWavBase64(json.audioContent, sampleRateHertz, 1);
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
  let llmStream;
  if (cfg.llmVendor === "openai") {
    const llm = await openai.chat.completions.create({
      model: cfg.llmModel,
      temperature: 0.7,
      stream: true,
      messages,
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
        fmt = "wav";
      } else if (cfg.ttsVendor === "google") {
        b64 = await ttsToBase64Google(t, voice);
        fmt = "wav";
      } else {
        throw new Error("Unknown ttsVendor");
      }
      send(res, "tts", { id: segSeq, format: fmt, b64 });
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
