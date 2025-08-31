// index.mjs
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const HEAD_MIN_CHARS = 24;
const SEG_MAX_CHARS  = 48;
const TTS_FORMAT     = "wav";
const VOICE_DEFAULT  = "alloy";

const send  = (res, ev, data)=>res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

export const handler = awslambda.streamifyResponse(async (event, res) => {
  res.setContentType("text/event-stream");

  // 入力（base64対応）
  let body = {};
  try {
    if (event.body) {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body;
      body = JSON.parse(raw);
    }
  } catch (e) {
    send(res, "error", { message: "Invalid JSON" });
    res.end(); return;
  }

  const voice = body.voice ?? VOICE_DEFAULT;
  const input = body.input ?? [{ role:"user", content:"自己紹介して" }];

  // TTFB
  send(res, "ping", { t: Date.now() });

  let buf = "";
  let textAll = "";
  let headSent = false;
  let segSeq = 0;

  try {
    const stream = await openai.responses.stream({
      model: "gpt-5-mini",
      input
    });

    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") {
        const delta = ev.delta;
        if (!delta) continue;

        textAll += delta;
        buf     += delta;
        send(res, "llm_token", { token: delta });

        if (!headSent && textAll.replace(/\s+/g,"").length >= HEAD_MIN_CHARS) {
          headSent = true;
          const headText = sliceToSentence(textAll, HEAD_MIN_CHARS);
          fireTTS(res, headText, voice, { kind:"head", seq:0 }).catch(()=>{});
        }

        if (endsWithSentence(buf) || buf.length >= SEG_MAX_CHARS) {
          const segText = buf.trim();
          buf = "";
          if (segText) {
            segSeq += 1;
            fireTTS(res, segText, voice, { kind:"seg", seq: segSeq }).catch(()=>{});
          }
        }
      }

      if (ev.type === "response.completed") break;
      if (ev.type === "response.refusal.delta") {
        send(res, "refusal", { delta: ev.delta });
      }
    }
  } catch (err) {
    const detail = err?.response?.data ?? err?.message ?? String(err);
    send(res, "error", { message: "OpenAI call failed", detail });
    res.end(); return;
  }

  if (buf.trim()) {
    segSeq += 1;
    await fireTTS(res, buf.trim(), voice, { kind:"seg", seq: segSeq }).catch(()=>{});
  }

  if (textAll.trim()) {
    const b64 = await ttsToBase64(textAll, voice).catch(()=>null);
    if (b64) send(res, "tts_chunk", { kind:"full", seq: 9999, bytes_base64: b64 });
  }

  send(res, "done", {});
  res.end();
});

// ---- ヘルパ ----
function endsWithSentence(s) { return /[。！？!?]\s*$/.test(s); }
function sliceToSentence(text, maxLen) {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(.+?[。！？!?])/);
  const sent = m ? m[1] : t.slice(0, maxLen);
  return sent.slice(0, maxLen);
}
async function fireTTS(res, text, voice, meta) {
  const b64 = await ttsToBase64(text, voice);
  send(res, "tts_chunk", { ...meta, bytes_base64: b64, text });
}
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
