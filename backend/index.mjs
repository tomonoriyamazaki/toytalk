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
  OpenAI: {
    vendor: "openai",
    llmModel: "gpt-4.1-mini",
    ttsModel: "gpt-4o-mini-tts",
  },
  Gemini: {
    vendor: "google",
    llmModel: "gemini-2.5-flash",  // ★後で実際に使う
    ttsModel: "gemini-speech",     // ★後で実際に使う
  },
  // ここに将来 Gemini / NijiVoice を足していく
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

// ▼（後で実装）Gemini TTS → base64
async function ttsToBase64Gemini(text, voice, ttsModel) {
  // TODO: Google SDK / REST を呼ぶ（env: GOOGLE_API_KEY）
  throw new Error("Gemini TTS not wired yet");
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
  send(res, "mark", { k: "vendor", v: cfg.vendor });
  if (DEBUG_TIME) console.log("[route]", { rawModel, modelKey, vendor: cfg.vendor });

  // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
  if (DEBUG_TIME) {
    send(res, "ping", { t: Date.now() });
  }

  // ---- LLM 開始 ----
  if (DEBUG_TIME) {
    send(res, "mark", { k: "llm_start", t: Date.now() });
  }
  let llmStream;
  if (cfg.vendor === "openai") {
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
  } else if (cfg.vendor === "google") {
    // TODO: Google Generative AI SDK / REST で text streaming
    // とりあえず “通る” 仮実装（単発返答してストリームに見せる）
    const fallback = "（Gemini ルートの接続準備中です。OpenAI ルートは動作中）";
    llmStream = (async function* () { yield fallback; })();
  } else {
    const fallback = "未対応ベンダーです。";
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
    const b64 = cfg.vendor === "openai"
        ? await ttsToBase64OpenAI(t, voice, cfg.ttsModel)
        : await ttsToBase64Gemini(t, voice, cfg.ttsModel); // 現状は未実装で例外
    send(res, "tts", { id: segSeq, format: TTS_FORMAT, b64 });
    if (cfg.vendor === "openai") {
      const b64 = await ttsToBase64OpenAI(t, voice, cfg.ttsModel);
      send(res, "tts", { id: segSeq, format: TTS_FORMAT, b64 });
    } else {
      // Gemini は今はテキストのみ（TTS未実装）
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
