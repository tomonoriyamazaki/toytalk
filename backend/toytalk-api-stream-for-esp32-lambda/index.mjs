  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, SAKURA_API_KEY
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

  const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const DEVICES_TABLE    = "toytalker-devices";
  const VOICES_TABLE     = "toytalker-voices";
  const CHARACTERS_TABLE = "toytalker-characters";
  const CHAT_LOGS_TABLE  = "toytalker-chat-logs";
  const LLMS_TABLE       = "toytalker-llms";
  const USAGE_TABLE         = "toytalker-usage";
  const UNIT_PRICES_TABLE   = "toytalker-api-unit-prices";
  const EXCHANGE_RATES_TABLE = "toytalker-exchange-rates";

  async function saveLog(item) {
    try {
      await ddb.send(new PutCommand({ TableName: CHAT_LOGS_TABLE, Item: item }));
    } catch (e) {
      console.error("[saveLog] error:", e);
    }
  }

  // ---- 単価・マージン・為替レートのキャッシュ ----
  let cachedPrices = null;
  let cachedMargin = null;
  let cachedRates = {};
  let cacheLoadedAt = 0;
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
        if (pk === "service#margin") {
          cachedMargin = Number(item.margin) || 1.5;
        } else {
          prices[pk] = item;
        }
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
      const result = await ddb.send(new GetCommand({
        TableName: EXCHANGE_RATES_TABLE,
        Key: { month, currency },
      }));
      const rate = Number(result.Item?.rate) || 150;
      cachedRates[cacheKey] = rate;
      return rate;
    } catch (e) {
      console.error("[ExchangeRate] error:", e);
      return 150;
    }
  }

  function calcCostJpy({ providerApiType, tokensIn, tokensOut, characters, utf8Bytes, mora, pcmBytes, userMessageChars, usdJpyRate }) {
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
      costUsd += (tokensIn ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "tokens" || outputUnit === "audio_tokens") {
        costUsd += (tokensOut ?? 0) * Number(price.unit_price_output);
      }
    } else if (inputUnit === "characters") {
      costUsd += (characters ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "audio_tokens" && pcmBytes) {
        const durationSec = pcmBytes / (24000 * 2);
        const audioTokens = Math.round((durationSec / 60) * 800);
        costUsd += audioTokens * Number(price.unit_price_output);
      }
    } else if (inputUnit === "utf8_bytes") {
      costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
    } else if (inputUnit === "audio_tokens") {
      const chars = userMessageChars ?? 0;
      const textTokens = Math.round(chars * 0.3);
      const speechSec = chars / 6;
      const audioTokens = Math.round(speechSec * (30000 / 3600));
      costUsd += audioTokens * Number(price.unit_price_input);
      costUsd += textTokens * Number(price.unit_price_output);
    }
    const costJpy = costUsd * usdJpyRate * margin;
    return { costJpy, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
  }

  async function addUsage({ ownerId, deviceId, date, apiType, provider, model, costJpy, tokensIn, tokensOut, ttsCharacters, sttCharacters, usdJpyRate, unitPriceUsd, margin }) {
    if (!costJpy || costJpy <= 0) return;
    const sk = `${date}#${deviceId}#${apiType}`;
    try {
      const addParts = ["cost_jpy :cost", "requests :one"];
      const vals = { ":cost": costJpy, ":one": 1, ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin };
      if (tokensIn)      { addParts.push("tokens_in :tin");       vals[":tin"]  = tokensIn; }
      if (tokensOut)     { addParts.push("tokens_out :tout");     vals[":tout"] = tokensOut; }
      if (ttsCharacters) { addParts.push("tts_characters :ttsc"); vals[":ttsc"] = ttsCharacters; }
      if (sttCharacters) { addParts.push("stt_characters :sttc"); vals[":sttc"] = sttCharacters; }
      await ddb.send(new UpdateCommand({
        TableName: USAGE_TABLE,
        Key: { owner_id: ownerId, "date#device_id#api_type": sk },
        UpdateExpression: `ADD ${addParts.join(", ")} SET provider = :p, model = :m, usd_jpy_rate = :r, unit_price_usd = :u, margin = :mg`,
        ExpressionAttributeValues: vals,
      }));
    } catch (e) {
      console.error("[addUsage] error:", e);
    }
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ---- チューニング定数 ----
  const HEAD_MIN_CHARS = 24;      // 今回は使わない（ヘッドTTS無効）
  const SEG_MAX_CHARS  = 100;     // 文末で自然に区切るため増加（安全網として残す）
  const TTS_FORMAT     = "pcm";
  const VOICE_DEFAULT  = "alloy";
  const DEBUG          = false;
  const DEBUG_TIME     = process.env.DEBUG_TIME === "true";

  // Binary protocol helpers
  // Send JSON metadata (type=0x01)
  const sendMeta = (res, ev, data) => {
    const json = JSON.stringify({ event: ev, ...data });
    const buf = Buffer.from(json, "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0x01, 0);           // type: metadata
    header.writeUInt32LE(buf.length, 1);  // length
    res.write(header);
    res.write(buf);
  };

  // Send binary PCM data (type=0x02)
  const sendPCM = (res, pcmBuffer) => {
    const header = Buffer.alloc(5);
    header.writeUInt8(0x02, 0);              // type: PCM audio
    header.writeUInt32LE(pcmBuffer.length, 1); // length
    res.write(header);
    res.write(pcmBuffer);
  };

  const sha1  = (s)=>createHash("sha1").update(s).digest("hex");

  // ---- TTS設定（プロバイダーごと）----
  const TTS_DEFAULT = "OpenAI";
  const TTS_TABLE = {
    OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts-2025-03-20" },
    Google:     { ttsVendor: "google",     ttsModel: "google-tts" },
    Gemini:     { ttsVendor: "gemini",     ttsModel: "gemini-2.5-flash-preview-tts" },
    ElevenLabs: { ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2_5" },
    FishAudio:  { ttsVendor: "fishaudio",  ttsModel: "fishaudio" },
    Sakura:     { ttsVendor: "sakura",     ttsModel: "sakura" },
  };

  // ---- LLMデフォルト（llm_id未設定時のフォールバック）----
  const LLM_DEFAULT_PROVIDER = "openai";
  const LLM_DEFAULT_MODEL    = "gpt-4.1-mini";



  // 文末かどうか（簡易）
  function endsWithSentence(s) {
    return /[。！？!?]\s*$/.test(s);
  }

// OpenAI TTS → Buffer (raw PCM)
async function ttsBufferOpenAI(text, voice, ttsModel) {
  try {
    const tts = await openai.audio.speech.create({
      model: ttsModel,
      input: text,
      voice,
      response_format: "pcm"
    });

    const buf = Buffer.from(await tts.arrayBuffer());
    console.log(`[TTS] PCM size: ${buf.length} bytes`);

    // 先頭が MP3 だったらフォールバックで WAV 再取得
    if (buf[0] === 0xFF && (buf[1] === 0xF3 || buf[1] === 0xFB || buf[0] === 0x49)) {
      console.warn("[TTS] PCM not returned, retrying as WAV");
      const tts2 = await openai.audio.speech.create({
        model: ttsModel.replace("mini", "tts"),
        input: text,
        voice,
        format: "wav"
      });
      return Buffer.from(await tts2.arrayBuffer());
    }

    // 本物のPCM Bufferを返す
    // デバッグ: 最初の16バイトを確認
    const head = buf.slice(0, 16);
    console.log(`[TTS OpenAI] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS OpenAI] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return buf;

  } catch (err) {
    console.error("[TTS] OpenAI PCM fetch failed:", err);
    throw err;
  }
}

  // Google Cloud Text-to-Speech (API Key) → Buffer (raw PCM)
  async function ttsBufferGoogle(
    text,
    {
      voiceName,
      speakingRate = 1.2,
      pitch = 3.0,
      sampleRateHertz = 24000,
      audioEncoding = "LINEAR16",
    } = {}
  ) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GOOGLE_API_KEY is not set");
    // 例: "ja-JP-Neural2-B" → "ja-JP"
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
          audioConfig: {
            audioEncoding,
            speakingRate,
            pitch,
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
    // json.audioContent は LINEAR16 (base64) → 生のBufferに変換
    const pcmBuffer = Buffer.from(json.audioContent, "base64");
    console.log(`[TTS Google] PCM size: ${pcmBuffer.length} bytes`);

    // Google TTS特有の冒頭クリック音対策: フェードイン処理
    const fadeMs = 20;  // 20ミリ秒
    const fadeSamples = Math.floor(sampleRateHertz * fadeMs / 1000);
    for (let i = 0; i < fadeSamples && i * 2 < pcmBuffer.length; i++) {
      const fade = i / fadeSamples;  // 0→1
      const sample = pcmBuffer.readInt16LE(i * 2);
      pcmBuffer.writeInt16LE(Math.round(sample * fade), i * 2);
    }

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Google] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Google] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }


  // Gemini Speech Generation → Buffer (raw PCM)（APIキーは GOOGLE_API_KEY を共用）
  async function ttsBufferGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
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

    // 24kHz/mono PCM16 base64 → 生のBufferに変換
    const pcmBuffer = Buffer.from(b64Pcm, "base64");
    console.log(`[TTS Gemini] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Gemini] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Gemini] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }

  // ElevenLabs TTS → Buffer (raw PCM)
  async function ttsBufferElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`ElevenLabs TTS failed: ${resp.status} ${errorText}`);
    }

    // レスポンスヘッダーを確認
    const contentType = resp.headers.get('content-type');
    console.log(`[TTS ElevenLabs] Content-Type: ${contentType}`);

    // PCMバイナリデータを直接返す
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS ElevenLabs] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS ElevenLabs] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS ElevenLabs] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }


  // FishAudio TTS → Buffer (raw PCM via MP3 decode is not feasible on Lambda;
  // FishAudio supports pcm output via format param)
  async function ttsBufferFishAudio(text, { referenceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.FISHAUDIO_API_KEY;
    if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
    const resp = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`FishAudio TTS failed: ${resp.status} ${errorText}`);
    }
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS FishAudio] PCM size: ${pcmBuffer.length} bytes`);
    return pcmBuffer;
  }

  // Sakura (VOICEVOX) TTS → Buffer (raw PCM)
  async function ttsBufferSakura(text, { model = "zundamon", style = "normal" } = {}) {
    const key = process.env.SAKURA_API_KEY;
    if (!key) throw new Error("SAKURA_API_KEY is not set");

    const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "audio/wav",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: style,
        response_format: "wav",
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Sakura TTS failed: ${resp.status} ${errorText}`);
    }

    const wavBuffer = Buffer.from(await resp.arrayBuffer());
    // WAVヘッダ（44バイト）をスキップしてPCMデータを取得
    const pcmBuffer = wavBuffer.slice(44);
    console.log(`[TTS Sakura] WAV size: ${wavBuffer.length}, PCM size: ${pcmBuffer.length} bytes`);

    return pcmBuffer;
  }

  // DynamoDBからdevice_idに紐づくキャラクター＆ボイス設定を解決
  // 解決チェーン: device → character(voice_id + personality_prompt) → voice(provider + vendor_id)
  async function resolveCharacterFromDynamo(deviceId) {
    try {
      const deviceRes = await ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id: deviceId },
      }));
      const device = deviceRes.Item;
      if (!device) return null;

      let voiceId = null;
      let personalityPrompt = null;
      let llmId = null;

      if (device.character_id && device.character_id !== "default") {
        const charRes = await ddb.send(new GetCommand({
          TableName: CHARACTERS_TABLE,
          Key: { character_id: device.character_id },
        }));
        if (charRes.Item) {
          voiceId = charRes.Item.voice_id ?? null;
          personalityPrompt = charRes.Item.personality_prompt || null;
          llmId = charRes.Item.llm_id ?? null;
        }
      }

      if (!voiceId) voiceId = device.voice_id ?? null;
      if (!voiceId) return null;

      const voiceRes = await ddb.send(new GetCommand({
        TableName: VOICES_TABLE,
        Key: { voice_id: voiceId },
      }));
      if (!voiceRes.Item) return null;

      // LLM設定を解決（llm_id未設定ならデフォルト）
      let llmProvider = LLM_DEFAULT_PROVIDER;
      let llmModelId  = LLM_DEFAULT_MODEL;
      if (llmId) {
        const llmRes = await ddb.send(new GetCommand({
          TableName: LLMS_TABLE,
          Key: { llm_id: llmId },
        }));
        if (llmRes.Item) {
          llmProvider = llmRes.Item.provider;
          llmModelId  = llmRes.Item.model_id;
        }
      }

      return {
        provider: voiceRes.Item.provider,
        vendorId: voiceRes.Item.vendor_id,
        personalityPrompt,
        ownerId: device.owner_id ?? null,
        characterId: device.character_id ?? "default",
        llmProvider,
        llmModelId,
      };
    } catch (e) {
      console.error("[DynamoDB] resolveCharacterFromDynamo error:", e);
      return null;
    }
  }

  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("application/octet-stream");

    const body    = event.body ? JSON.parse(event.body) : {};
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const deviceId = typeof body.device_id === "string" ? body.device_id : null;

    // ---- ログ用メタデータ ----
    const sessionId  = typeof body.session_id === "string" ? body.session_id : "unknown";
    let   ownerId    = typeof body.owner_id   === "string" ? body.owner_id   : deviceId ?? "unknown";
    const requestAt  = Date.now();
    const userTimestamp = new Date(requestAt).toISOString();

    function normalizeModelKey(k) {
      if (!k) return undefined;
      const s = String(k).toLowerCase();
      if (s.includes("openai"))      return "OpenAI";
      if (s.includes("google"))      return "Google";
      if (s.includes("gemini"))      return "Gemini";
      if (s.includes("elevenlabs"))  return "ElevenLabs";
      if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
      if (s.includes("sakura"))    return "Sakura";
      return undefined;
    }

    // device_idがあればDynamoDBからキャラクター＆ボイス設定を取得、なければbodyの値を使う
    let ttsKey = normalizeModelKey(body.model) ?? TTS_DEFAULT;
    let voice    = body.voice ?? VOICE_DEFAULT;
    let personalityPrompt = null;
    let llmProvider = LLM_DEFAULT_PROVIDER;
    let llmModelId  = LLM_DEFAULT_MODEL;
    let characterId = "default";

    if (deviceId) {
      const charConfig = await resolveCharacterFromDynamo(deviceId);
      if (charConfig) {
        ttsKey = normalizeModelKey(charConfig.provider) ?? ttsKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        llmProvider = charConfig.llmProvider;
        llmModelId  = charConfig.llmModelId;
        characterId = charConfig.characterId ?? "default";
        if (charConfig.ownerId) ownerId = charConfig.ownerId;
        console.log(`[DynamoDB] device=${deviceId}, tts=${charConfig.provider}, voice=${charConfig.vendorId}, llm=${llmProvider}/${llmModelId}, hasPersonality=${!!personalityPrompt}, ownerId=${ownerId}`);
      } else {
        console.log(`[DynamoDB] device=${deviceId} not found or no character set, using defaults`);
      }
    }

    const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];

    sendMeta(res, "mark", { k: "model", v: ttsKey });
    sendMeta(res, "mark", { k: "llm_vendor", v: llmProvider });
    sendMeta(res, "mark", { k: "llm_model", v: llmModelId });
    sendMeta(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      sendMeta(res, "ping", { t: Date.now() });
    }

    // ---- ユーザーメッセージ保存 ----
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === "user" && sessionId !== "unknown") {
      saveLog({
        "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
        "session_id#timestamp": `session_id#${sessionId}#timestamp#${userTimestamp}`,
        owner_id: ownerId, device_id: deviceId, source: "esp",
        role: "user", content: lastUserMsg.content,
        content_type: "audio", timestamp: userTimestamp, session_id: sessionId,
      });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      sendMeta(res, "mark", { k: "llm_start", t: Date.now() });
    }

    // システムプロンプトを追加（キャラクターの個性 + 共通指示）
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const basePrompt = `あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。漢字は最小限にして、ひらがな多めで答えてください。単語の間に半角スペースを入れないでください。現在の日時は${now}です。日時を聞かれたら年は省略して簡潔に答えてください。相手が話した言語で返答してください。`;
    const systemPrompt = {
      role: "system",
      content: personalityPrompt ? `${personalityPrompt}\n\n${basePrompt}` : basePrompt,
    };
    const messagesWithSystem = [systemPrompt, ...messages];

    // ---- ストリーム状態 ----
    let buf = "";
    let textAll = "";
    let segSeq = 0;
    let lastSegHash = "";
    let firstTtsMarked = false;
    let ttsChain = Promise.resolve();
    let llmTokensIn = 0, llmTokensOut = 0;
    let ttsInputChars = 0;

    // ---- LLM ストリーム生成 ----
    function streamLLMOpenAI(msgs, model) {
      return (async function* () {
        const llm = await openai.chat.completions.create({
          model,
          temperature: 0.7,
          stream: true,
          stream_options: { include_usage: true },
          messages: msgs,
        });
        for await (const chunk of llm) {
          if (chunk.usage) {
            llmTokensIn  = chunk.usage.prompt_tokens     ?? 0;
            llmTokensOut = chunk.usage.completion_tokens ?? 0;
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) yield delta;
        }
      })();
    }

    function streamLLMGemini(msgs, model) {
      const systemMsg = msgs.find(m => m.role === "system");
      const chatMsgs = msgs.filter(m => m.role !== "system");
      const contents = chatMsgs.map(m => ({
        role: m.role === "assistant" ? "model" : m.role,
        parts: [{ text: m.content }],
      }));
      const body = { contents };
      if (systemMsg) {
        body.systemInstruction = { parts: [{ text: systemMsg.content }] };
      }
      body.generationConfig = { temperature: 0.7 };

      const key = process.env.GOOGLE_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;

      return (async function* () {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Gemini API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
              if (parsed.usageMetadata) {
                llmTokensIn  = parsed.usageMetadata.promptTokenCount ?? 0;
                llmTokensOut = parsed.usageMetadata.candidatesTokenCount ?? 0;
              }
              if (text) yield text;
            } catch {}
          }
        }
      })();
    }

    function streamLLMAnthropic(msgs, model) {
      const systemMsg = msgs.find(m => m.role === "system");
      const chatMsgs = msgs.filter(m => m.role !== "system");

      const body = {
        model,
        max_tokens: 1024,
        stream: true,
        temperature: 0.7,
        messages: chatMsgs,
      };
      if (systemMsg) {
        body.system = systemMsg.content;
      }

      const key = process.env.ANTHROPIC_API_KEY;

      return (async function* () {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Anthropic API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "content_block_delta") {
                const text = parsed.delta?.text ?? "";
                if (text) yield text;
              } else if (parsed.type === "message_delta" && parsed.usage) {
                llmTokensOut = parsed.usage.output_tokens ?? 0;
              } else if (parsed.type === "message_start" && parsed.message?.usage) {
                llmTokensIn = parsed.message.usage.input_tokens ?? 0;
              } else if (parsed.type === "message_stop") {
                return;
              }
            } catch {}
          }
        }
      })();
    }

    let llmStream;
    if (llmProvider === "openai") {
      llmStream = streamLLMOpenAI(messagesWithSystem, llmModelId);
    } else if (llmProvider === "google") {
      llmStream = streamLLMGemini(messagesWithSystem, llmModelId);
    } else if (llmProvider === "anthropic") {
      llmStream = streamLLMAnthropic(messagesWithSystem, llmModelId);
    } else {
      const fallback = "（LLM ルート未実装です）";
      llmStream = (async function* () { yield fallback; })();
    }


    // segment を送る唯一の経路
    async function emitSegment(text, { final=false } = {}) {
      const t = String(text ?? "").trim().replace(/(?<=[\u3000-\u9fff])\s+(?=[\u3000-\u9fff])/g, "");
      if (!t) return;
      const h = sha1(t);
      if (h === lastSegHash) return;     // 同一文は再送しない
      lastSegHash = h;
      segSeq += 1;

      // 画面用の確定テキスト（メタデータとして送信）
      sendMeta(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        sendMeta(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      ttsInputChars += t.length;

      // 音声チャンク（生PCMバイナリとして送信）
      try {
        let pcmBuffer;
        if (cfg.ttsVendor === "openai") {
          const voiceName = voice === "default" ? "nova" : voice;
          pcmBuffer = await ttsBufferOpenAI(t, voiceName, cfg.ttsModel);
        } else if (cfg.ttsVendor === "google") {
          const voiceName = voice === "default" ? "ja-JP-Neural2-C" : voice;  // 男性
          pcmBuffer = await ttsBufferGoogle(t, { voiceName });
        } else if (cfg.ttsVendor === "gemini") {
          const voiceName = voice === "default" ? "Kore" : voice;
          pcmBuffer = await ttsBufferGemini(t, { model: cfg.ttsModel, voiceName });
        } else if (cfg.ttsVendor === "elevenlabs") {
          const voiceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;  // Sameno（子供向け）
          pcmBuffer = await ttsBufferElevenLabs(t, { model: cfg.ttsModel, voiceId });
        } else if (cfg.ttsVendor === "fishaudio") {
          const referenceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;
          pcmBuffer = await ttsBufferFishAudio(t, { referenceId });
        } else if (cfg.ttsVendor === "sakura") {
          const modelName = voice === "default" ? "zundamon" : voice;
          pcmBuffer = await ttsBufferSakura(t, { model: modelName });
        } else {
          throw new Error("Unknown ttsVendor");
        }
        // メタデータでチャンク情報を送信
        sendMeta(res, "tts_start", { id: segSeq, size: pcmBuffer.length });
        // PCMバイナリを直接送信
        sendPCM(res, pcmBuffer);
        console.log(`[Lambda] id=${segSeq}, pcm.length=${pcmBuffer.length} bytes, text="${t}"`);
      } catch (e) {
        sendMeta(res, "error", { message: `TTS failed: ${e?.message || e}` });
      }
    }

    // ---- LLM ストリーム処理（共通インターフェース）----
    try {
      // ---- LLM ストリーム処理（共通）----
      for await (const delta of llmStream) {
        textAll += delta;
        buf     += delta;
        if (DEBUG) sendMeta(res, "llm_token", { token: delta });
        // buf内に文末があれば即分割してTTSに送る
        let match;
        while ((match = buf.match(/^(.*?[。！？!?])\s*/s))) {
          const segText = match[1].trim();
          buf = buf.slice(match[0].length);
          if (segText) await emitSegment(segText);
        }
        if (buf.trim().length >= SEG_MAX_CHARS) {
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
      sendMeta(res, "done", {});

      // ---- コスト計算 + usage書き込み + ログ保存 ----
      if (sessionId !== "unknown" && textAll.trim()) {
        const assistantTimestamp = new Date().toISOString();

        await loadPricingCache();
        const date = assistantTimestamp.slice(0, 10);
        const month = assistantTimestamp.slice(0, 7);
        const usdJpyRate = await getExchangeRate(month);

        // LLM
        const llmPriceKey = `${llmProvider}#llm`;
        const llmCost = calcCostJpy({ providerApiType: llmPriceKey, tokensIn: llmTokensIn, tokensOut: llmTokensOut, usdJpyRate });
        if (llmCost) {
          await addUsage({ ownerId, deviceId, date, apiType: "llm", provider: llmProvider, model: llmModelId, costJpy: llmCost.costJpy, tokensIn: llmTokensIn, tokensOut: llmTokensOut, usdJpyRate: llmCost.usdJpyRate, unitPriceUsd: llmCost.unitPriceUsd, margin: llmCost.margin });
        }

        // TTS
        const ttsPriceKey = `${cfg.ttsVendor}#tts`;
        let ttsCostResult;
        if (cfg.ttsVendor === "sakura") {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, mora: ttsInputChars, usdJpyRate });
        } else if (cfg.ttsVendor === "fishaudio") {
          const utf8Bytes = Buffer.byteLength(textAll.trim(), "utf8");
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, utf8Bytes, usdJpyRate });
        } else {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, characters: ttsInputChars, usdJpyRate });
        }
        if (ttsCostResult) {
          await addUsage({ ownerId, deviceId, date, apiType: "tts", provider: cfg.ttsVendor, model: cfg.ttsModel, costJpy: ttsCostResult.costJpy, ttsCharacters: ttsInputChars, usdJpyRate: ttsCostResult.usdJpyRate, unitPriceUsd: ttsCostResult.unitPriceUsd, margin: ttsCostResult.margin });
        }

        // STT (確定文の文字数から概算)
        const userMsgChars = lastUserMsg?.content?.length ?? 0;
        let sttCost = null;
        if (userMsgChars > 0) {
          sttCost = calcCostJpy({ providerApiType: "soniox#stt", userMessageChars: userMsgChars, usdJpyRate });
          if (sttCost) {
            await addUsage({ ownerId, deviceId, date, apiType: "stt", provider: "soniox", model: "soniox", costJpy: sttCost.costJpy, sttCharacters: userMsgChars, usdJpyRate: sttCost.usdJpyRate, unitPriceUsd: sttCost.unitPriceUsd, margin: sttCost.margin });
          }
        }

        await saveLog({
          "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
          "session_id#timestamp": `session_id#${sessionId}#timestamp#${assistantTimestamp}`,
          owner_id: ownerId, device_id: deviceId, source: "esp",
          role: "assistant", content: textAll.trim(),
          content_type: "text", timestamp: assistantTimestamp, session_id: sessionId,
          llm_provider: llmProvider, llm_model: llmModelId,
          llm_tokens_in: llmTokensIn, llm_tokens_out: llmTokensOut,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: "soniox", stt_input_units: null, stt_input_unit_type: null,
          duration_ms: Date.now() - requestAt,
          character_id: characterId,
          voice_id: voice,
          cost_stt: sttCost?.costJpy ?? 0,
          cost_llm: llmCost?.costJpy ?? 0,
          cost_tts: ttsCostResult?.costJpy ?? 0,
          cost_total: (sttCost?.costJpy ?? 0) + (llmCost?.costJpy ?? 0) + (ttsCostResult?.costJpy ?? 0),
        });
      }
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      sendMeta(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
