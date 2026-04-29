// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: ANTHROPIC_API_KEY, SAKURA_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
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

// ---- Haiku LLM (相槌生成) ----
async function generateBackchannel(partialText, personalityPrompt, history = []) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");

  const historyContext = history.length > 0
    ? "\n直前の会話:\n" + history.map(h => `${h.role === "user" ? "ユーザー" : "あなた"}: ${h.content}`).join("\n") + "\n"
    : "";

  const systemPrompt = `あなたは会話相手で、相槌を打つ役割です。${personalityPrompt ? "あなたの性格: " + personalityPrompt + "\n" : ""}${historyContext}ユーザーが今まさに話している途中です。聞こえている部分と会話の流れに合った、自然な相槌を一言だけ返してください。
ルール:
- 相槌とは「聞いているよ」「わかるよ」という反応のこと
- 必ず1〜8文字程度の短い相槌のみ
- 句読点不要
- 会話の流れに合わせてバリエーション豊かに（同じ相槌の連続を避ける）
- 楽しい話題: わぁ、いいね、おー、やったー
- 困った話題: えぇー、うーん、そっかぁ
- 驚き: えっ、まじで、ほんとに
- 共感: わかる、だよね、そうそう
- 挨拶: おはよう、こんにちは、やっほー（会話の最初のみ）
- 普通の相槌: うんうん、へぇー、そうなんだ、なるほど、ふーん
- キャラの口調を反映してよいが、相槌として不自然な語尾は使わない
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

// ---- TTS functions ----

function pcm16ToWavBase64(pcmBase64, sampleRate, channels) {
  const pcm = Buffer.from(pcmBase64, "base64");
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

async function ttsToBase64Sakura(text, { model = "zundamon", style = "normal" } = {}) {
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
  return wavBuffer.toString("base64");
}

async function ttsToBase64OpenAI(text, { model = "gpt-4o-mini-tts", voice = "alloy" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text, voice, response_format: "wav" }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status}`);
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  return wavBuffer.toString("base64");
}

async function ttsToBase64Google(text, { voiceName = "ja-JP-Neural2-B", speakingRate = 1.0, pitch = 0, sampleRateHertz = 24000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const resp = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "ja-JP", name: voiceName },
        audioConfig: { audioEncoding: "LINEAR16", speakingRate, pitch, sampleRateHertz },
      }),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  return pcm16ToWavBase64(json.audioContent, sampleRateHertz, 1);
}

async function ttsToBase64Gemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Read the following text aloud: ${text}` }] }],
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
  return pcm16ToWavBase64(b64Pcm, 24000, 1);
}

async function ttsToBase64ElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
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
  const pcmBuf = Buffer.from(await resp.arrayBuffer());
  return pcm16ToWavBase64(pcmBuf.toString("base64"), 24000, 1);
}

async function ttsToBase64FishAudio(text, { referenceId = "e58b0d7efca34eb38d5c4985e9e1e3e6" } = {}) {
  const key = process.env.FISHAUDIO_API_KEY;
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "wav" }),
  });
  if (!resp.ok) throw new Error(`FishAudio TTS failed: ${resp.status}`);
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  return wavBuffer.toString("base64");
}

// ---- TTS ルーティング ----
async function generateTTS(text, vendor, voice) {
  switch (vendor) {
    case "sakura":     return ttsToBase64Sakura(text, { model: voice || "zundamon" });
    case "openai":     return ttsToBase64OpenAI(text, { voice: voice || "alloy" });
    case "google":     return ttsToBase64Google(text, { voiceName: voice });
    case "gemini":     return ttsToBase64Gemini(text, { voiceName: voice || "Kore" });
    case "elevenlabs": return ttsToBase64ElevenLabs(text, { voiceId: voice });
    case "fishaudio":  return ttsToBase64FishAudio(text, { referenceId: voice });
    default:           return ttsToBase64Sakura(text, { model: "zundamon" });
  }
}

// ---- Handler ----
export const handler = async (event) => {
  const start = Date.now();
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const partialText = body.partial_text ?? "";
    const characterId = body.character_id ?? null;
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

    if (!partialText) {
      return { statusCode: 400, body: JSON.stringify({ error: "partial_text is required" }) };
    }

    // キャラクター設定を解決
    let ttsVendor = "sakura";
    let ttsVoice = "zundamon";
    let personalityPrompt = null;

    if (characterId && characterId !== "default") {
      const charConfig = await resolveCharacter(characterId);
      if (charConfig) {
        const ttsKey = normalizeModelKey(charConfig.provider) ?? TTS_DEFAULT;
        const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];
        ttsVendor = cfg.ttsVendor;
        ttsVoice = charConfig.vendorId ?? ttsVoice;
        personalityPrompt = charConfig.personalityPrompt;
      }
    }

    // LLM + TTS を並列実行
    const [backchannelText, _] = await Promise.all([
      generateBackchannel(partialText, personalityPrompt, history),
      // TTS は backchannelText が必要なので後で実行
    ]);

    console.log(`[Backchannel] "${partialText}" → "${backchannelText}" (${Date.now() - start}ms) history=${history.length}turns`);

    const ttsStart = Date.now();
    const audioBase64 = await generateTTS(backchannelText, ttsVendor, ttsVoice);
    console.log(`[TTS] ${ttsVendor}/${ttsVoice} (${Date.now() - ttsStart}ms)`);

    console.log(`[Total] ${Date.now() - start}ms`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: backchannelText,
        audio: audioBase64,
        format: "wav",
        latency_ms: Date.now() - start,
      }),
    };
  } catch (err) {
    console.error("[Backchannel] error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
