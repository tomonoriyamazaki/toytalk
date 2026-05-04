// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// ESP32向け相槌Lambda: raw PCMバイナリをレスポンスボディで返す
// ヘッダ X-Backchannel-Text に相槌テキストを格納
// Env: GOOGLE_API_KEY, OPENAI_API_KEY, SAKURA_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const DEVICES_TABLE    = "toytalker-devices";
const CHARACTERS_TABLE = "toytalker-characters";
const VOICES_TABLE     = "toytalker-voices";

// ---- TTS設定 ----
const TTS_TABLE = {
  OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts" },
  Google:     { ttsVendor: "google",     ttsModel: "google" },
  Gemini:     { ttsVendor: "gemini",     ttsModel: "gemini-2.5-flash-preview-tts" },
  ElevenLabs: { ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2_5" },
  FishAudio:  { ttsVendor: "fishaudio",  ttsModel: "fishaudio" },
  Sakura:     { ttsVendor: "sakura",     ttsModel: "sakura" },
};
const TTS_DEFAULT = "Sakura";

function normalizeModelKey(k) {
  if (!k) return undefined;
  const s = String(k).toLowerCase();
  if (s.includes("openai"))      return "OpenAI";
  if (s.includes("google"))      return "Google";
  if (s.includes("gemini"))      return "Gemini";
  if (s.includes("elevenlabs"))  return "ElevenLabs";
  if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
  if (s.includes("sakura"))      return "Sakura";
  return undefined;
}

// ---- device_idからキャラクター解決（ESP用） ----
async function resolveCharacterFromDevice(deviceId) {
  try {
    const deviceRes = await ddb.send(new GetCommand({
      TableName: DEVICES_TABLE,
      Key: { device_id: deviceId },
    }));
    const device = deviceRes.Item;
    if (!device) return null;

    if (device.character_id && device.character_id !== "default") {
      return resolveCharacter(device.character_id);
    }
    return null;
  } catch (e) {
    console.error("[resolveCharacterFromDevice] error:", e);
    return null;
  }
}

// ---- キャラクター解決 ----
async function resolveCharacter(characterId) {
  try {
    const charRes = await ddb.send(new GetCommand({
      TableName: CHARACTERS_TABLE,
      Key: { character_id: characterId },
    }));
    if (!charRes.Item) return null;

    const voiceId = charRes.Item.voice_id;
    const personalityPrompt = charRes.Item.personality_prompt || null;
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
    console.error("[resolveCharacter] error:", e);
    return null;
  }
}

// ---- LLM (相槌生成 - Gemini Flash) ----
async function generateBackchannel(partialText, personalityPrompt, history = [], pastBackchannels = []) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "numeric" });
  const isFirstTurn = history.length === 0;

  const historyContext = history.length > 0
    ? "\n直前の会話:\n" + history.map(h => `${h.role === "user" ? "ユーザー" : "あなた"}: ${h.content}`).join("\n") + "\n"
    : "";

  const firstTurnHint = isFirstTurn
    ? `\n- 会話の最初なので、時間帯（現在${now}）に合った挨拶で返してもよい（必須ではない）`
    : "";

  const avoidHint = pastBackchannels.length > 0
    ? `\n- 過去に使った相槌: ${pastBackchannels.join("、")}。これらとは違う表現を使うこと`
    : "";

  const systemPrompt = `あなたは会話相手で、相槌を打つ役割です。${personalityPrompt ? "あなたの性格: " + personalityPrompt + "\n" : ""}${historyContext}ユーザーが今まさに話している途中です。聞こえている部分と会話の流れに合った、自然な相槌を一言だけ返してください。
ルール:
- 相槌とは「聞いているよ」「わかるよ」という短い反応のこと
- 1〜15文字程度
- 句読点不要
- 話題の内容や感情に合った相槌を自分で考えて返す（楽しい・困っている・驚き・共感など）
- 会話の流れを見て、毎回違う表現を使う${firstTurnHint}${avoidHint}
- キャラの口調は使わず、自然な日本語の相槌にする
- 絶対に質問・返答・感想・コメントはしない。相槌のみ`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `（話し中）${partialText}` }] }],
        generationConfig: { maxOutputTokens: 20, temperature: 0.9, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini failed: ${resp.status} ${errText}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "うん";
  return text.trim();
}

// ---- TTS functions (raw PCM Buffer) ----

async function ttsPcmOpenAI(text, { model = "gpt-4o-mini-tts", voice = "alloy" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text, voice, response_format: "pcm" }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmGoogle(text, { voiceName = "ja-JP-Neural2-B", sampleRateHertz = 24000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
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
        audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.2, pitch: 3.0, sampleRateHertz },
      }),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  return Buffer.from(json.audioContent, "base64");
}

async function ttsPcmGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
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
  return Buffer.from(b64Pcm, "base64");
}

async function ttsPcmElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    }
  );
  if (!resp.ok) throw new Error(`ElevenLabs TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmFishAudio(text, { referenceId = "e58b0d7efca34eb38d5c4985e9e1e3e6" } = {}) {
  const key = process.env.FISHAUDIO_API_KEY;
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
  });
  if (!resp.ok) throw new Error(`FishAudio TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmSakura(text, { model = "zundamon", style = "normal" } = {}) {
  const key = process.env.SAKURA_API_KEY;
  if (!key) throw new Error("SAKURA_API_KEY is not set");
  const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Accept": "audio/wav",
    },
    body: JSON.stringify({ model, input: text, voice: style, response_format: "wav" }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Sakura TTS failed: ${resp.status} ${errorText}`);
  }
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  return wavBuffer.slice(44); // WAVヘッダ(44bytes)をスキップ
}

// ---- TTS ルーティング ----
async function generateTTSPcm(text, vendor, voice) {
  switch (vendor) {
    case "sakura":     return ttsPcmSakura(text, { model: voice || "zundamon" });
    case "openai":     return ttsPcmOpenAI(text, { voice: voice || "alloy" });
    case "google":     return ttsPcmGoogle(text, { voiceName: voice });
    case "gemini":     return ttsPcmGemini(text, { voiceName: voice || "Kore" });
    case "elevenlabs": return ttsPcmElevenLabs(text, { voiceId: voice });
    case "fishaudio":  return ttsPcmFishAudio(text, { referenceId: voice });
    default:           return ttsPcmSakura(text, { model: "zundamon" });
  }
}

// ---- Handler (BUFFEREDモード - isBase64Encodedでバイナリ返却) ----
export const handler = async (event) => {
  const start = Date.now();
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const partialText = body.partial_text ?? "";
    const deviceId = body.device_id ?? null;
    const characterId = body.character_id ?? null;
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const pastBackchannels = Array.isArray(body.past_backchannels) ? body.past_backchannels.slice(-10) : [];

    if (!partialText) {
      return { statusCode: 400, body: JSON.stringify({ error: "partial_text is required" }) };
    }

    // キャラクター設定を解決（device_id優先、なければcharacter_id）
    let ttsVendor = "sakura";
    let ttsVoice = "zundamon";
    let personalityPrompt = null;

    let charConfig = null;
    if (deviceId) {
      charConfig = await resolveCharacterFromDevice(deviceId);
    }
    if (!charConfig && characterId && characterId !== "default") {
      charConfig = await resolveCharacter(characterId);
    }
    if (charConfig) {
      const ttsKey = normalizeModelKey(charConfig.provider) ?? TTS_DEFAULT;
      const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];
      ttsVendor = cfg.ttsVendor;
      ttsVoice = charConfig.vendorId ?? ttsVoice;
      personalityPrompt = charConfig.personalityPrompt;
    }

    // LLM生成
    const backchannelText = await generateBackchannel(partialText, personalityPrompt, history, pastBackchannels);
    console.log(`[Backchannel] "${partialText}" → "${backchannelText}" (${Date.now() - start}ms) history=${history.length}turns`);

    // TTS生成 (raw PCM)
    const ttsStart = Date.now();
    const pcmBuffer = await generateTTSPcm(backchannelText, ttsVendor, ttsVoice);
    console.log(`[TTS] ${ttsVendor}/${ttsVoice} pcm=${pcmBuffer.length}bytes (${Date.now() - ttsStart}ms)`);
    console.log(`[Total] ${Date.now() - start}ms`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Backchannel-Text": encodeURIComponent(backchannelText),
        "X-Pcm-Length": String(pcmBuffer.length),
        "X-Latency-Ms": String(Date.now() - start),
      },
      body: pcmBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[Backchannel] error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
