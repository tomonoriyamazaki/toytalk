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

// 文末かどうか（簡易）
function endsWithSentence(s) {
  return /[。！？!?]\s*$/.test(s);
}

// OpenAI TTS → base64
async function ttsToBase64(text, voice) {
  const tts = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    input: text,
    voice,
    format: TTS_FORMAT
  });
  const buf = Buffer.from(await tts.arrayBuffer());
  return buf.toString("base64");
}

export const handler = awslambda.streamifyResponse(async (event, res) => {
  res.setContentType("text/event-stream");

  const body    = event.body ? JSON.parse(event.body) : {};
  const voice   = body.voice ?? VOICE_DEFAULT;
  const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];

  // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
  if (DEBUG_TIME) {
    send(res, "ping", { t: Date.now() });
  }

  // ---- LLM 開始 ----
  if (DEBUG_TIME) {
    send(res, "mark", { k: "llm_start", t: Date.now() });
  }
  const llm = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    stream: true,
    messages
  });

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
    const b64 = await ttsToBase64(t, voice);
    send(res, "tts", { id: segSeq, format: TTS_FORMAT, b64 });
  }

  // ---- LLM ストリーム処理 ----
  for await (const chunk of llm) {
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (!delta) continue;

    textAll += delta;
    buf     += delta;
    if (DEBUG) send(res, "llm_token", { token: delta });

    // 文末 or 長さで切る
    if (endsWithSentence(buf) || buf.trim().length >= SEG_MAX_CHARS) {
      const segText = buf.trim();
      buf = ""; 
      await emitSegment(segText);
    }
  }

  // 末尾に残りがあれば最後に1回だけ
  const tail = buf.trim();
  if (tail.length > 0) {
    buf = "";
    await emitSegment(tail, { final: true });
  }

  send(res, "done", {});
  res.end();
});
