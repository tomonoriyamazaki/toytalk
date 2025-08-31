// Lambda runtime: Node.js 18+
// Handler: index.handler
// Function URL: Invoke mode = RESPONSE_STREAM
// Env: OPENAI_API_KEY

import OpenAI from "openai";

// ★ Lambda内では awslambda はグローバルで使える（import不要）
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 小さなユーティリティ
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (res, ev, data) =>
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

export const handler = awslambda.streamifyResponse(async (event, res) => {
  // SSEヘッダ
  res.setContentType("text/event-stream");

  // 1) クライアント側のTTFB計測用“ping”
  send(res, "ping", { t: Date.now() });

  // 入力（必要に応じて取り回してね）
  // ここでは簡易に JSON body: { messages: [{role, content}...], voice?: "anime" }
  const body = event.body ? JSON.parse(event.body) : {};
  const messages = body.messages ?? [{ role: "user", content: "自己紹介して" }];
  const voice = body.voice ?? "alloy"; // OpenAIのTTSボイス名に合わせて変更

  // 2) LLMをストリーミング開始（先に“文字”を流す）
  let textSoFar = "";
  let headTtsFired = false;

  // OpenAI v4 SDK: chat.completions (streaming)
  const llmStream = await openai.chat.completions.create({
    model: "gpt-4o-mini",          // ここは使っているモデルに合わせて
    stream: true,
    temperature: 0.7,
    messages
  });

  // LLMの読み取りと“ヘッドTTS”を並行に
  const llmReader = (async () => {
    for await (const chunk of llmStream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      textSoFar += delta;
      send(res, "llm_token", { token: delta });

      // “ヘッドクリップ”のトリガー：先頭が出そろったら1回だけTTSを先行
      if (!headTtsFired && textSoFar.length >= 30) { // 目安 20〜50文字
        headTtsFired = true;
        // 先頭の一文 or 60〜120字くらいで短いTTSを作る
        const headText = extractHead(textSoFar, 90);
        fireHeadTTS(res, headText, voice).catch(console.error);
      }
    }
  })();

  await llmReader; // LLM完了

  // 3) 本編のフルTTS（1ファイル）を生成して流す（MVP）
  //   ※ まずは“先頭すぐ鳴る体験”を確定させる。のちに「本編を小分け」で上書き可能。
  if (textSoFar.trim().length > 0) {
    await sendFullTTS(res, textSoFar, voice);
  }

  // 4) 終了
  send(res, "done", {});
  res.end();
});

// ---- ヘルパ ----

// 先頭の一文（もしくは最大N文字）を抽出
function extractHead(text, maxLen = 90) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const m = trimmed.match(/(.+?[。！？!?.])/); // 一文
  const head = m ? m[1] : trimmed.slice(0, maxLen);
  return head.slice(0, maxLen);
}

// 先頭プレビューTTS（~300〜500msくらいを狙う短文）
async function fireHeadTTS(res, text, voice) {
  try {
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",       // 利用中のTTSモデルに合わせて
      voice,                          // 例: "alloy" / "verse" / "anime" など
      input: text,
      format: "wav"                   // クライアントが扱いやすい形式で
      // stream: 現状SDKはレスポンス全体。MVPは一発でOK
    });
    // SDKは ArrayBuffer 互換を返す（環境により .arrayBuffer() が必要）
    const audioBuf = Buffer.from(await tts.arrayBuffer());
    const b64 = audioBuf.toString("base64");
    send(res, "tts_chunk", { kind: "head", bytes_base64: b64 });
  } catch (e) {
    send(res, "log", { level: "warn", msg: "head tts failed", err: String(e) });
  }
}

// 本編のフルTTSを作って1発で送る（MVP）
// 後で“分割送出”に差し替え可能
async function sendFullTTS(res, text, voice) {
  // 長すぎると生成に時間がかかる → 適宜サマリ/分割はあとで
  const tts = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
    format: "wav"
  });
  const audioBuf = Buffer.from(await tts.arrayBuffer());
  const b64 = audioBuf.toString("base64");
  // “head”のあとに“full”を送る。クライアント側でヘッドをフェードアウト→本編へ切替
  send(res, "tts_chunk", { kind: "full", bytes_base64: b64 });
}
