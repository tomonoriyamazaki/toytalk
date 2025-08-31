// index.mjs — LLMストリーム + TTS + segment可視化（ESM / Node.js 18 / Handler: index.handler）
import OpenAI from "openai";
import { randomBytes } from "node:crypto";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rid = () => randomBytes(20).toString("hex");

// 句読点優先で30–50字に分割
const seg = (text, min=30, max=50) => {
  const out=[]; let buf=""; const flush=()=>{const t=buf.trim(); if(t) out.push(t); buf="";};
  for (const ch of text) { buf+=ch; const punct=/[。！？!?]/.test(ch)||ch==="\n"; if((punct&&buf.length>=5)||buf.length>=max) flush(); }
  if (buf.length>=min) flush();
  return out;
};

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const http = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
  const send = (ev, obj) => { http.write(`event: ${ev}\n`); http.write(`data: ${JSON.stringify(obj)}\n\n`); };

  if (event.requestContext?.http?.method === "OPTIONS") { http.write("ok\n"); http.end(); return; }

  // 入力
  let body={};
  try { body = typeof event.body==="string" ? JSON.parse(event.body||"{}") : (event.body||{}); }
  catch { send("error",{code:"BAD_JSON",message:"Invalid JSON body"}); http.end(); return; }

  const {
    messages = [{ role:"user", content:"こんにちは！" }],
    temperature = 0.7,
    model = process.env.OPENAI_MODEL || "gpt-4.1-mini",
    // TTS
    tts = false,
    ttsVoice = process.env.TTS_VOICE || "alloy",
    ttsModel = process.env.TTS_MODEL || "gpt-4o-mini-tts",
    ttsFormat = process.env.TTS_FORMAT || "mp3",
    ttsHeadChars = 18,
    ttsSegMin = 30, ttsSegMax = 50,
    emitSegText = true,                // ★ 追加: チャンク文字列の可視化（既定オン）
    // 任意
    maxTokens,
    requestId = rid(),
  } = body;

  send("meta", { requestId, model, tts: !!tts, ttsVoice, ttsModel, ttsFormat, ttsSegMin, ttsSegMax, emitSegText, serverTime: Date.now() });

  let full=""; let headDone=false; let ttft=null; const t0=Date.now();

  // --- TTSキュー（IDで管理）
  const Q=[]; let active=0; const CONC=2;
  let nextId = 0;                // ★ 各セグメントのID
  const enqueueSeg = (text) => {
    const id = nextId++;
    if (emitSegText) send("segment", { id, text });   // ★ 先に“そのままの文字列”を送る
    Q.push({ id, text });
    pump();
  };
  const pump = () => {
    while (tts && active<CONC && Q.length) {
      const { id, text } = Q.shift(); active++;
      (async () => {
        try {
          const r = await openai.audio.speech.create({ model: ttsModel, voice: ttsVoice, input: text, format: ttsFormat });
          const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
          send("tts", { id, format: ttsFormat, b64 }); // ★ 同じ id で音声を返す
        } catch (e) {
          send("warn", { type:"tts", id, message:String(e?.message||e) });
        } finally {
          active--; pump();
        }
      })();
    }
  };

  // --- LLMストリーム
  try {
    const stream = await openai.chat.completions.create({
      model, temperature, max_tokens: maxTokens, stream: true, messages,
    });

    for await (const ch of stream) {
      const piece = ch?.choices?.[0]?.delta?.content ?? "";
      if (!piece) continue;

      if (ttft==null) { ttft = Date.now()-t0; send("metric", { name:"ttft_ms", value: ttft }); }

      // 画面用の逐次テキスト（従来どおり）
      send("delta", { text: piece });

      // バッファして分割 → TTSキューへ
      full += piece;

      if (tts) {
        if (!headDone && full.length >= ttsHeadChars) {
          headDone = true;
          enqueueSeg(full.slice(0, Math.max(ttsHeadChars, 12)));
        }
        const parts = seg(full, ttsSegMin, ttsSegMax);
        if (parts.length) {
          const consumed = parts.join("").length;
          for (const s of parts) enqueueSeg(s);
          full = full.slice(consumed).trimStart();
        }
      }
    }
  } catch (e) {
    send("error", { code:"OPENAI_STREAM_ERROR", message:String(e?.message||e) });
    http.end(); return;
  }

  // 残りテキスト
  if (tts && full.trim().length) {
    for (const s of seg(full, 1, 80)) enqueueSeg(s);
  }

  // TTS待ち（最大20s）
  const tWait = Date.now();
  while (tts && (active>0 || Q.length>0) && Date.now()-tWait < 20_000) {
    await new Promise(r => setTimeout(r, 50));
  }

  send("done", { t: Date.now() });
  http.end();
});
