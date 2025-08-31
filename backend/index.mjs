// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: OPENAI_API_KEY
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- チューニング定数（まずはこのままでOK） ----
const HEAD_MIN_CHARS = 24;      // 先頭プレビューTTSのトリガ（20〜40目安）
const SEG_MAX_CHARS  = 48;      // 文が来ない時の強制カット（30〜50目安）
const TTS_FORMAT     = "wav";   // 実装簡単なWAV。帯域が気になればm4a/CAFへ
const VOICE_DEFAULT  = "alloy";

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const send  = (res, ev, data)=>res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

export const handler = awslambda.streamifyResponse(async (event, res) => {
  res.setContentType("text/event-stream");

  // 入力
  const body = event.body ? JSON.parse(event.body) : {};
  const voice = body.voice ?? VOICE_DEFAULT;
  const messages = body.messages ?? [{ role:"user", content:"自己紹介して" }];

  // 即TTFB確認
  send(res, "ping", { t: Date.now() });

  // LLMストリーム開始
  const llm = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    stream: true,
    messages
  });

  let buf = "";             // トークン蓄積
  let textAll = "";         // 全文
  let headSent = false;     // ヘッドTTS済みフラグ
  let segSeq = 0;           // セグメント番号

  // LLMトークンを読みつつ：1) 文字はそのまま流す 2) 文/長さでTTSを発火
  for await (const chunk of llm) {
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (!delta) continue;

    textAll += delta;
    buf     += delta;
    send(res, "llm_token", { token: delta }); // 文字も見せる

    // ヘッドTTS（先頭プレビュー）— 一度だけ
    if (!headSent && textAll.replace(/\s+/g,"").length >= HEAD_MIN_CHARS) {
      headSent = true;
      const headText = sliceToSentence(textAll, HEAD_MIN_CHARS); // 区切り良く
      fireTTS(res, headText, voice, { kind:"head", seq:0 }).catch(()=>{});
    }

    // 文末出現 or 長すぎたらセグメントTTS
    if (endsWithSentence(buf) || buf.length >= SEG_MAX_CHARS) {
      const segText = buf.trim();
      buf = ""; // クリア
      if (segText) {
        segSeq += 1;
        fireTTS(res, segText, voice, { kind:"seg", seq: segSeq }).catch(()=>{});
      }
    }
  }

  // 取りこぼし（末尾に句点がないケース）
  if (buf.trim()) {
    segSeq += 1;
    await fireTTS(res, buf.trim(), voice, { kind:"seg", seq: segSeq });
  }

  // 全文の“保険”としてフル音声（クライアント側で未再生分があれば使う）
  if (textAll.trim()) {
    const b64 = await ttsToBase64(textAll, voice);
    send(res, "tts_chunk", { kind:"full", seq: 9999, bytes_base64: b64 });
  }

  send(res, "done", {});
  res.end();
});

// ---- ヘルパ ----

// 文末かどうか（簡易）
function endsWithSentence(s) {
  return /[。！？!?]\s*$/.test(s);
}

// ヘッド用：なるべく一文、なければ指定長まで
function sliceToSentence(text, maxLen) {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(.+?[。！？!?])/);
  const sent = m ? m[1] : t.slice(0, maxLen);
  return sent.slice(0, maxLen);
}

// TTSを呼んで送信
async function fireTTS(res, text, voice, meta) {
  const b64 = await ttsToBase64(text, voice);
  send(res, "tts_chunk", { ...meta, bytes_base64: b64, text });
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
