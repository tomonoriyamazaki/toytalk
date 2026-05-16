// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// 用途: テキストを受け取り、選択ボイスのTTSだけで音声化して直接ストリーミング返却する（LLM/STT/相槌なし）。
//       アプリの「読み上げ」専用機能のためのLambda。音声はサーバー側に保存しない。
// 入力: { text, voice_id, owner_id? }
// 出力: 音声バイナリ（Content-Type: audio/wav | audio/mpeg, ヘッダ X-Audio-Format に wav|mp3）
// Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, SAKURA_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL
import OpenAI from "openai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const VOICES_TABLE         = "toytalker-voices";
const USAGE_TABLE          = "toytalker-usage";
const UNIT_PRICES_TABLE    = "toytalker-api-unit-prices";
const EXCHANGE_RATES_TABLE = "toytalker-exchange-rates";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TTS_FORMAT    = "wav";
const TTS_DEFAULT   = "OpenAI";
const VOICE_DEFAULT = "alloy";
const TTS_TABLE = {
  OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts" },
  Google:     { ttsVendor: "google",     ttsModel: "google-tts" },
  Gemini:     { ttsVendor: "gemini",     ttsModel: "gemini-2.5-flash-preview-tts" },
  ElevenLabs: { ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2_5" },
  FishAudio:  { ttsVendor: "fishaudio",  ttsModel: "fishaudio" },
  Sakura:     { ttsVendor: "sakura",     ttsModel: "sakura" },
  ZakiCorp:   { ttsVendor: "zakicorp",   ttsModel: "zakicorp-tts" },
};

function normalizeModelKey(k) {
  if (!k) return undefined;
  const s = String(k).toLowerCase();
  if (s.includes("openai"))      return "OpenAI";
  if (s.includes("google"))      return "Google";
  if (s.includes("gemini"))      return "Gemini";
  if (s.includes("elevenlabs"))  return "ElevenLabs";
  if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
  if (s.includes("sakura"))      return "Sakura";
  if (s.includes("zakicorp") || s.includes("qwen")) return "ZakiCorp";
  return undefined;
}

// 改行を「文の区切り（長めのポーズ）」として扱う。
// TTSは改行で間を取らないため、各行末に句点を補い全プロバイダー共通でポーズを作る。
// 既に文末記号で終わる行はそのまま、空行は除去。
function applyLineBreakPauses(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length <= 1) return lines[0] ?? "";
  return lines
    .map((s) => (/[。．.！!？?…」』）)]$/.test(s) ? s : s + "。"))
    .join("\n");
}

// ===== TTS プロバイダー（toytalk-stream-handler-lambda から流用。base64返却）=====

async function ttsToBase64OpenAI(text, voice, ttsModel) {
  const tts = await openai.audio.speech.create({ model: ttsModel, input: text, voice, format: TTS_FORMAT });
  const buf = Buffer.from(await tts.arrayBuffer());
  return buf.toString("base64");
}

// PCM16 (LINEAR16) を WAV へラップして base64 を返す
function pcm16ToWavBase64(pcmB64, sampleRate = 24000, channels = 1) {
  let pcm = Buffer.from(pcmB64, "base64");
  const bytesPerSample = 2;
  const totalSamples = pcm.length / bytesPerSample;

  // DCオフセット除去
  let sum = 0;
  for (let i = 0; i < totalSamples; i++) sum += pcm.readInt16LE(i * 2);
  const mean = sum / totalSamples;
  for (let i = 0; i < totalSamples; i++) {
    const v = pcm.readInt16LE(i * 2) - mean;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }

  // 先頭/末尾をハニング窓でフェード（冒頭クリック音潰し）
  const fadeMs = 12;
  const fadeSamples = Math.min(Math.floor(sampleRate * fadeMs / 1000), Math.floor(totalSamples / 4));
  for (let i = 0; i < fadeSamples; i++) {
    const wIn  = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    const wOut = 0.5 * (1 - Math.cos(Math.PI * (fadeSamples - i) / fadeSamples));
    const vi = pcm.readInt16LE(i * 2);
    pcm.writeInt16LE(Math.round(vi * wIn), i * 2);
    const idx = (totalSamples - 1 - i) * 2;
    const vo = pcm.readInt16LE(idx);
    pcm.writeInt16LE(Math.round(vo * wOut), idx);
  }

  // 先頭の無音パッド
  const padHeadMs = 40;
  const padSamples = Math.max(1, Math.floor(sampleRate * padHeadMs / 1000));
  const pad = Buffer.alloc(padSamples * bytesPerSample, 0);
  pcm = Buffer.concat([pad, pcm]);

  const byteRate   = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize   = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
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

function pcmToWavBase64(pcmBuf, sampleRate = 24000, channels = 1) {
  const wav = Buffer.alloc(44 + pcmBuf.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBuf.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBuf.length, 40);
  pcmBuf.copy(wav, 44);
  return wav.toString("base64");
}

async function ttsToBase64Google(text, { voiceName = "ja-JP-Neural2-B", speakingRate = 1.3, pitch = 3.0, sampleRateHertz = 24000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate, pitch, sampleRateHertz },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  return pcm16ToWavBase64(json.audioContent, sampleRateHertz, 1);
}

async function ttsToBase64Gemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "leda" } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const ttsPrompt = `Read the following text aloud: ${text}`;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ttsPrompt }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          model,
        }),
      }
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
    const b64Pcm = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    if (b64Pcm) {
      const audioTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;
      return { b64: pcm16ToWavBase64(b64Pcm, 24000, 1), audioTokens };
    }
  }
  throw new Error("Gemini TTS: empty audio after retries");
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
  if (!resp.ok) throw new Error(`ElevenLabs TTS failed: ${resp.status} ${await resp.text()}`);
  const pcmBuffer = Buffer.from(await resp.arrayBuffer());
  return pcm16ToWavBase64(pcmBuffer.toString("base64"), 24000, 1);
}

async function ttsToBase64FishAudio(text, { referenceId = "6fdaebea7db042129f03ecb0a57ea7b6" } = {}) {
  const key = process.env.FISHAUDIO_API_KEY;
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "mp3", latency: "low" }),
  });
  if (!resp.ok) throw new Error(`Fish Audio TTS failed: ${resp.status} ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

async function ttsToBase64Sakura(text, { model = "zundamon", style = "normal" } = {}) {
  const key = process.env.SAKURA_API_KEY;
  if (!key) throw new Error("SAKURA_API_KEY is not set");
  const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Accept": "audio/wav" },
    body: JSON.stringify({ model, input: text, voice: style, response_format: "wav" }),
  });
  if (!resp.ok) throw new Error(`Sakura TTS failed: ${resp.status} ${await resp.text()}`);
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  return wavBuffer.toString("base64");
}

async function ttsToBase64ZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}) {
  const key = process.env.ZAKICORP_API_KEY;
  const baseUrl = process.env.ZAKICORP_TTS_URL;
  if (!key || !baseUrl) throw new Error("ZAKICORP_API_KEY or ZAKICORP_TTS_URL is not set");
  const resp = await fetch(`${baseUrl}/v1/tts/stream`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, language, speaker }),
  });
  if (!resp.ok) throw new Error(`ZakiCorp TTS failed: ${resp.status} ${await resp.text()}`);
  const sampleRate = parseInt(resp.headers.get("X-Sample-Rate") || "24000");
  const channels = parseInt(resp.headers.get("X-Channels") || "1");
  const pcmBuf = Buffer.from(await resp.arrayBuffer());
  return pcmToWavBase64(pcmBuf, sampleRate, channels);
}

// ===== ボイス解決（voice_id → toytalker-voices → {provider, vendor_id}）=====
async function resolveVoiceFromDynamo(voiceId) {
  try {
    const res = await ddb.send(new GetCommand({ TableName: VOICES_TABLE, Key: { voice_id: voiceId } }));
    if (!res.Item) return null;
    return { provider: res.Item.provider, vendorId: res.Item.vendor_id };
  } catch (e) {
    console.error("[DynamoDB] resolveVoiceFromDynamo error:", e);
    return null;
  }
}

// ===== コスト計算 + usage 書き込み（TTS分のみ。stream-handler から流用）=====
let cachedPrices = null, cachedMargin = null, cachedRates = {}, cacheLoadedAt = 0;
const CACHE_TTL_MS = 3600_000;

async function loadPricingCache() {
  if (cachedPrices && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS) return;
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: UNIT_PRICES_TABLE,
      FilterExpression: "version = :v",
      ExpressionAttributeValues: { ":v": "current" },
    }));
    const prices = {};
    for (const item of (result.Items ?? [])) {
      const pk = item["provider#api_type"];
      if (pk === "service#margin") cachedMargin = Number(item.margin) || 1.5;
      else prices[pk] = item;
    }
    cachedPrices = prices;
    cacheLoadedAt = Date.now();
  } catch (e) {
    console.error("[Pricing] cache load error:", e);
  }
}

async function getExchangeRate(month, currency = "JPY") {
  const cacheKey = `${month}#${currency}`;
  if (cachedRates[cacheKey]) return cachedRates[cacheKey];
  try {
    const result = await ddb.send(new GetCommand({ TableName: EXCHANGE_RATES_TABLE, Key: { month, currency } }));
    const rate = Number(result.Item?.rate) || 150;
    cachedRates[cacheKey] = rate;
    return rate;
  } catch (e) {
    console.error("[ExchangeRate] error:", e);
    return 150;
  }
}

function calcTtsCostJpy({ providerApiType, characters, utf8Bytes, mora, pcmBytes, audioTokens, usdJpyRate }) {
  const price = cachedPrices?.[providerApiType];
  if (!price) return null;
  const margin = cachedMargin || 1.5;

  if (price.currency === "JPY") {
    const inputCost = (mora ?? 0) * Number(price.unit_price_input);
    return { costJpy: inputCost * margin, usdJpyRate: null, unitPriceUsd: null, margin };
  }

  const inputUnit = price.input_unit_type;
  const outputUnit = price.output_unit_type;
  let costUsd = 0;
  if (inputUnit === "tokens") {
    costUsd += (characters ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "audio_tokens") costUsd += (audioTokens ?? 0) * Number(price.unit_price_output);
  } else if (inputUnit === "characters") {
    costUsd += (characters ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "audio_tokens" && pcmBytes) {
      const durationSec = pcmBytes / (24000 * 2);
      const at = Math.round((durationSec / 60) * 800);
      costUsd += at * Number(price.unit_price_output);
    }
  } else if (inputUnit === "utf8_bytes") {
    costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
  }
  const costJpy = costUsd * usdJpyRate * margin;
  return { costJpy, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
}

async function addUsage({ ownerId, deviceId, date, provider, model, costJpy, ttsCharacters, usdJpyRate, unitPriceUsd, margin }) {
  if (!costJpy || costJpy <= 0) return;
  const sk = `${date}#${deviceId}#tts`;
  try {
    await ddb.send(new UpdateCommand({
      TableName: USAGE_TABLE,
      Key: { owner_id: ownerId, "date#device_id#api_type": sk },
      UpdateExpression: "ADD cost_jpy :cost, requests :one, tts_characters :ttsc SET provider = :p, model = :m, usd_jpy_rate = :r, unit_price_usd = :u, margin = :mg",
      ExpressionAttributeValues: {
        ":cost": costJpy, ":one": 1, ":ttsc": ttsCharacters,
        ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin,
      },
    }));
  } catch (e) {
    console.error("[addUsage] error:", e);
  }
}

async function trackTtsCost({ ownerId, ttsVendor, ttsModel, text, b64Len }) {
  try {
    await loadPricingCache();
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    const month = ts.slice(0, 7);
    const usdJpyRate = await getExchangeRate(month);
    const chars = [...text].length;
    const priceKey = `${ttsVendor}#tts`;
    let cost;
    if (ttsVendor === "openai") {
      const pcmBytes = Math.round(b64Len * 3 / 4) - 44;
      cost = calcTtsCostJpy({ providerApiType: priceKey, characters: chars, pcmBytes, usdJpyRate });
    } else if (ttsVendor === "fishaudio") {
      cost = calcTtsCostJpy({ providerApiType: priceKey, utf8Bytes: Buffer.byteLength(text, "utf8"), usdJpyRate });
    } else if (ttsVendor === "sakura") {
      cost = calcTtsCostJpy({ providerApiType: priceKey, mora: chars, usdJpyRate });
    } else {
      cost = calcTtsCostJpy({ providerApiType: priceKey, characters: chars, usdJpyRate });
    }
    if (cost) {
      await addUsage({
        ownerId, deviceId: "app", date, provider: ttsVendor, model: ttsModel,
        costJpy: cost.costJpy, ttsCharacters: chars,
        usdJpyRate: cost.usdJpyRate, unitPriceUsd: cost.unitPriceUsd, margin: cost.margin,
      });
    }
  } catch (e) {
    console.error("[trackTtsCost] error:", e);
  }
}

// ===== ハンドラ =====
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const text    = typeof body.text === "string" ? body.text.trim() : "";
  const voiceId = typeof body.voice_id === "string" ? body.voice_id : null;
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : "user_123";

  const fail = (statusCode, message) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "Content-Type": "application/json" },
    });
    s.write(JSON.stringify({ error: message }));
    s.end();
  };

  if (!text)    return fail(400, "text is required");
  if (!voiceId) return fail(400, "voice_id is required");

  // ボイス解決
  let ttsKey = TTS_DEFAULT;
  let voice  = VOICE_DEFAULT;
  const v = await resolveVoiceFromDynamo(voiceId);
  if (!v) return fail(404, `voice_id not found: ${voiceId}`);
  ttsKey = normalizeModelKey(v.provider) ?? TTS_DEFAULT;
  voice  = v.vendorId ?? VOICE_DEFAULT;
  const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];

  // 改行を文区切り（長めのポーズ）に変換してから合成
  const ttsText = applyLineBreakPauses(text);

  // TTS 実行
  let b64, fmt;
  try {
    if (cfg.ttsVendor === "openai") {
      b64 = await ttsToBase64OpenAI(ttsText, voice, cfg.ttsModel);
      fmt = "wav";
    } else if (cfg.ttsVendor === "google") {
      b64 = await ttsToBase64Google(ttsText, { voiceName: voice });
      fmt = "wav";
    } else if (cfg.ttsVendor === "gemini") {
      const result = await ttsToBase64Gemini(ttsText, { model: cfg.ttsModel, voiceName: voice });
      b64 = result.b64;
      fmt = "wav";
    } else if (cfg.ttsVendor === "elevenlabs") {
      b64 = await ttsToBase64ElevenLabs(ttsText, { model: cfg.ttsModel, voiceId: voice });
      fmt = "wav";
    } else if (cfg.ttsVendor === "fishaudio") {
      b64 = await ttsToBase64FishAudio(ttsText, { referenceId: voice });
      fmt = "mp3";
    } else if (cfg.ttsVendor === "sakura") {
      b64 = await ttsToBase64Sakura(ttsText, { model: voice === "default" ? "zundamon" : voice });
      fmt = "wav";
    } else if (cfg.ttsVendor === "zakicorp") {
      b64 = await ttsToBase64ZakiCorp(ttsText, { speaker: voice === "default" ? "vivian" : voice });
      fmt = "wav";
    } else {
      return fail(500, "Unknown ttsVendor");
    }
  } catch (e) {
    return fail(502, `TTS failed: ${e?.message || e}`);
  }

  // コスト記録（レスポンスとは独立、失敗しても無視）
  trackTtsCost({ ownerId, ttsVendor: cfg.ttsVendor, ttsModel: cfg.ttsModel, text: ttsText, b64Len: b64.length });

  // 音声バイナリを直接ストリーミング返却（S3に保存しない）
  const audioBuf = Buffer.from(b64, "base64");
  const mime = fmt === "mp3" ? "audio/mpeg" : "audio/wav";
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": mime,
      "X-Audio-Format": fmt,
      "Content-Disposition": `attachment; filename="toytalker-tts.${fmt}"`,
    },
  });
  out.write(audioBuf);
  out.end();
});
