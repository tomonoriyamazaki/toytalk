// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: なし（DynamoDBはIAMロールで接続）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(client);

// ---- テーブル定義 ----
const DEVICES_TABLE        = "toytalker-devices";
const VOICES_TABLE         = "toytalker-voices";
const CHARACTERS_TABLE     = "toytalker-characters";
const CHAT_LOGS_TABLE      = "toytalker-chat-logs";
const LLMS_TABLE           = "toytalker-llms";
const USAGE_TABLE          = "toytalker-usage";
const EXCHANGE_RATES_TABLE = "toytalker-exchange-rates";
const UNIT_PRICES_TABLE    = "toytalker-api-unit-prices";

// ---- 単価キャッシュ（コスト計算用） ----
let cachedPrices = null;
let cachedMargin = 1.5;
let cacheLoadedAt = 0;

async function loadPricingCache() {
  if (cachedPrices && (Date.now() - cacheLoadedAt) < 3600_000) return;
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

function calcCostFromLog(assistantItem, userContent, usdJpyRate) {
  const margin = cachedMargin;
  const result = { stt: null, llm: null, tts: null, total: 0 };

  // LLM
  const llmKey = `${assistantItem.llm_provider}#llm`;
  const llmPrice = cachedPrices?.[llmKey];
  if (llmPrice && (assistantItem.llm_tokens_in || assistantItem.llm_tokens_out)) {
    const tokIn = Number(assistantItem.llm_tokens_in) || 0;
    const tokOut = Number(assistantItem.llm_tokens_out) || 0;
    let costUsd = tokIn * Number(llmPrice.unit_price_input) + tokOut * Number(llmPrice.unit_price_output);
    const costJpy = costUsd * usdJpyRate * margin;
    result.llm = { cost: Math.round(costJpy * 1000) / 1000, tokens_in: tokIn, tokens_out: tokOut, provider: assistantItem.llm_provider, model: assistantItem.llm_model };
    result.total += costJpy;
  }

  // TTS
  const ttsVendor = assistantItem.tts_provider;
  const ttsKey = `${ttsVendor}#tts`;
  const ttsPrice = cachedPrices?.[ttsKey];
  if (ttsPrice) {
    const chars = Number(assistantItem.tts_input_units) || 0;
    let costJpy = 0;
    if (ttsPrice.currency === "JPY") {
      costJpy = chars * Number(ttsPrice.unit_price_input) * margin;
    } else if (ttsPrice.input_unit_type === "utf8_bytes") {
      const utf8Bytes = chars * 3;
      costJpy = utf8Bytes * Number(ttsPrice.unit_price_input) * usdJpyRate * margin;
    } else {
      costJpy = chars * Number(ttsPrice.unit_price_input) * usdJpyRate * margin;
    }
    result.tts = { cost: Math.round(costJpy * 1000) / 1000, characters: chars, provider: ttsVendor, model: assistantItem.tts_provider };
    result.total += costJpy;
  }

  // STT (確定文の文字数から概算)
  const userChars = userContent?.length ?? 0;
  const sttPrice = cachedPrices?.["soniox#stt"];
  if (sttPrice && userChars > 0) {
    const textTokens = Math.round(userChars * 0.3);
    const speechSec = userChars / 6;
    const audioTokens = Math.round(speechSec * (30000 / 3600));
    const costUsd = audioTokens * Number(sttPrice.unit_price_input) + textTokens * Number(sttPrice.unit_price_output);
    const costJpy = costUsd * usdJpyRate * margin;
    result.stt = { cost: Math.round(costJpy * 1000) / 1000, characters: userChars };
    result.total += costJpy;
  }

  result.total = Math.round(result.total * 1000) / 1000;
  return result;
}

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path   = event.rawPath ?? "/";

  console.log(`[Request] ${method} ${path}`);

  try {

    // ---- GET /llms ---- LLM一覧取得
    if (method === "GET" && path === "/llms") {
      const result = await ddb.send(new ScanCommand({ TableName: LLMS_TABLE }));
      return response(200, { llms: result.Items ?? [] });
    }

    // ---- GET /voices ---- ボイス一覧取得
    if (method === "GET" && path === "/voices") {
      const result = await ddb.send(new ScanCommand({ TableName: VOICES_TABLE }));
      return response(200, { voices: result.Items ?? [] });
    }

    // ---- GET /characters ---- キャラクター一覧取得（system + 自分のキャラ）
    if (method === "GET" && path === "/characters") {
      const userId = event.queryStringParameters?.owner_id ?? "user_123";
      const result = await ddb.send(new ScanCommand({
        TableName: CHARACTERS_TABLE,
        FilterExpression: "owner_id = :system OR owner_id = :userId",
        ExpressionAttributeValues: { ":system": "system", ":userId": userId },
      }));
      const sorted = (result.Items ?? []).sort((a, b) =>
        (a.created_at ?? "").localeCompare(b.created_at ?? "")
      );
      return response(200, { characters: sorted });
    }

    // ---- POST /characters ---- キャラクター作成
    if (method === "POST" && path === "/characters") {
      const body = JSON.parse(event.body ?? "{}");
      const { name, description = "", personality_prompt = "", voice_id = "elevenlabs_sameno", llm_id = "openai_gpt41mini", owner_id = "user_123" } = body;
      if (!name) return response(400, { error: "name is required" });

      const character_id = `${owner_id}_${Date.now()}`;
      await ddb.send(new PutCommand({
        TableName: CHARACTERS_TABLE,
        Item: {
          character_id,
          owner_id,
          name,
          description,
          personality_prompt,
          voice_id,
          llm_id,
          created_at: new Date().toISOString(),
        },
      }));
      return response(200, { character_id, message: "Character created" });
    }

    // ---- PUT /characters/{character_id} ---- キャラクター更新
    if (method === "PUT" && path.startsWith("/characters/")) {
      const character_id = decodeURIComponent(path.split("/")[2]);
      const body = JSON.parse(event.body ?? "{}");
      const { name, description, personality_prompt, voice_id } = body;

      // name / description は DynamoDB 予約語なので ExpressionAttributeNames でエスケープ
      const updates = [];
      const vals = {};
      const names = {};
      if (name              !== undefined) { updates.push("#nm = :n");  names["#nm"] = "name";        vals[":n"] = name; }
      if (description       !== undefined) { updates.push("#ds = :d");  names["#ds"] = "description"; vals[":d"] = description; }
      if (personality_prompt !== undefined) { updates.push("personality_prompt = :p");                 vals[":p"] = personality_prompt; }
      if (voice_id          !== undefined) { updates.push("voice_id = :v");                            vals[":v"] = voice_id; }
      if (body.llm_id       !== undefined) { updates.push("llm_id = :l");                              vals[":l"] = body.llm_id; }
      if (updates.length === 0) return response(400, { error: "No fields to update" });

      await ddb.send(new UpdateCommand({
        TableName: CHARACTERS_TABLE,
        Key: { character_id },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: vals,
      }));
      return response(200, { character_id, message: "Character updated" });
    }

    // ---- DELETE /characters/{character_id} ---- キャラクター削除（自分のキャラのみ）
    if (method === "DELETE" && path.startsWith("/characters/")) {
      const character_id = decodeURIComponent(path.split("/")[2]);
      const existing = await ddb.send(new GetCommand({
        TableName: CHARACTERS_TABLE,
        Key: { character_id },
      }));
      if (!existing.Item) return response(404, { error: "Character not found" });
      if (existing.Item.owner_id === "system") return response(403, { error: "Cannot delete system character" });

      await ddb.send(new DeleteCommand({
        TableName: CHARACTERS_TABLE,
        Key: { character_id },
      }));
      return response(200, { message: "Character deleted" });
    }

    // ---- POST /devices ---- デバイス登録
    if (method === "POST" && path === "/devices") {
      const body      = JSON.parse(event.body ?? "{}");
      const { device_id, owner_id = "user_123" } = body;
      if (!device_id) return response(400, { error: "device_id is required" });

      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: DEVICES_TABLE,
        Item: {
          device_id,
          owner_id,
          character_id: "default",
          device_name: "",
          created_at: now,
          last_seen: now,
        },
        // すでに存在する場合は created_at を上書きしない
        ConditionExpression: "attribute_not_exists(device_id)",
      })).catch(async (err) => {
        if (err.name === "ConditionalCheckFailedException") {
          // 登録済みなら last_seen と owner_id を更新
          await ddb.send(new UpdateCommand({
            TableName: DEVICES_TABLE,
            Key: { device_id },
            UpdateExpression: "SET last_seen = :t, owner_id = :o",
            ExpressionAttributeValues: { ":t": now, ":o": owner_id },
          }));
        } else {
          throw err;
        }
      });

      return response(200, { device_id, message: "Device registered" });
    }

    // ---- GET /devices ---- デバイス一覧取得（owner_id でフィルタ）
    if (method === "GET" && path === "/devices") {
      const owner_id = event.queryStringParameters?.owner_id;
      if (!owner_id) return response(400, { error: "owner_id is required" });

      const result = await ddb.send(new ScanCommand({
        TableName: DEVICES_TABLE,
        FilterExpression: "owner_id = :o",
        ExpressionAttributeValues: { ":o": owner_id },
      }));
      return response(200, { devices: result.Items ?? [] });
    }

    // ---- DELETE /devices/{device_id} ---- デバイス削除
    if (method === "DELETE" && path.startsWith("/devices/")) {
      const device_id = decodeURIComponent(path.split("/")[2]);
      const body = JSON.parse(event.body ?? "{}");
      const { owner_id } = body;

      const existing = await ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
      }));
      if (!existing.Item) return response(404, { error: "Device not found" });
      if (owner_id && existing.Item.owner_id !== owner_id) {
        return response(403, { error: "Not authorized to delete this device" });
      }

      await ddb.send(new DeleteCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
      }));
      return response(200, { message: "Device deleted" });
    }

    // ---- GET /devices/{device_id} ---- デバイス取得
    if (method === "GET" && path.startsWith("/devices/")) {
      const device_id = decodeURIComponent(path.split("/")[2]);
      const result = await ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
      }));
      if (!result.Item) return response(404, { error: "Device not found" });
      return response(200, result.Item);
    }

    // ---- PUT /devices/{device_id} ---- デバイス設定更新（character_id / device_name）
    if (method === "PUT" && path.startsWith("/devices/")) {
      const device_id = decodeURIComponent(path.split("/")[2]);
      const body      = JSON.parse(event.body ?? "{}");
      const { character_id, device_name } = body;

      const updates = ["last_seen = :t"];
      const vals = { ":t": new Date().toISOString() };
      if (character_id !== undefined) { updates.push("character_id = :c"); vals[":c"] = character_id; }
      if (device_name  !== undefined) { updates.push("device_name = :n");  vals[":n"] = device_name; }
      if (character_id === undefined && device_name === undefined) {
        return response(400, { error: "character_id or device_name is required" });
      }

      await ddb.send(new UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeValues: vals,
      }));
      return response(200, { device_id, message: "Device updated" });
    }

    // ---- GET /logs/sessions ---- セッション一覧取得
    if (method === "GET" && path === "/logs/sessions") {
      const ownerId  = event.queryStringParameters?.owner_id  ?? "user_123";
      const deviceId = event.queryStringParameters?.device_id ?? "app";
      const pk = `owner_id#${ownerId}#device_id#${deviceId}`;
      const result = await ddb.send(new QueryCommand({
        TableName: CHAT_LOGS_TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "owner_id#device_id" },
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: true, // 古い順→最初のユーザーメッセージをタイトルに使う
      }));
      // session_id ごとに最初のユーザーメッセージをタイトルとして取得し、最終活動時刻でソート
      const sessionMap = new Map();
      for (const item of (result.Items ?? [])) {
        const sid = item.session_id;
        if (!sessionMap.has(sid)) {
          sessionMap.set(sid, {
            session_id: sid,
            first_message: item.role === "user" ? item.content : "",
            timestamp: item.timestamp,
            last_timestamp: item.timestamp,
          });
        } else {
          const entry = sessionMap.get(sid);
          if (!entry.first_message && item.role === "user") {
            entry.first_message = item.content;
          }
          entry.last_timestamp = item.timestamp;
        }
      }
      // 最終活動時刻が新しい順にソート
      const sessions = Array.from(sessionMap.values())
        .sort((a, b) => b.last_timestamp.localeCompare(a.last_timestamp));
      return response(200, { sessions });
    }

    // ---- GET /logs/messages ---- セッション内メッセージ取得
    if (method === "GET" && path === "/logs/messages") {
      const ownerId   = event.queryStringParameters?.owner_id   ?? "user_123";
      const deviceId  = event.queryStringParameters?.device_id  ?? "app";
      const sessionId = event.queryStringParameters?.session_id;
      if (!sessionId) return response(400, { error: "session_id is required" });
      const pk = `owner_id#${ownerId}#device_id#${deviceId}`;
      const result = await ddb.send(new QueryCommand({
        TableName: CHAT_LOGS_TABLE,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk_prefix)",
        ExpressionAttributeNames: { "#pk": "owner_id#device_id", "#sk": "session_id#timestamp" },
        ExpressionAttributeValues: { ":pk": pk, ":sk_prefix": `session_id#${sessionId}#` },
        ScanIndexForward: true,
      }));
      return response(200, { messages: result.Items ?? [] });
    }

    // ---- GET /usage ---- 月次利用状況取得
    if (method === "GET" && path === "/usage") {
      const ownerId = event.queryStringParameters?.owner_id ?? "user_123";
      const month   = event.queryStringParameters?.month ?? new Date().toISOString().slice(0, 7);

      // usageテーブルから該当月のレコードを取得
      const result = await ddb.send(new QueryCommand({
        TableName: USAGE_TABLE,
        KeyConditionExpression: "owner_id = :oid AND begins_with(#sk, :monthPrefix)",
        ExpressionAttributeNames: { "#sk": "date#device_id#api_type" },
        ExpressionAttributeValues: { ":oid": ownerId, ":monthPrefix": month },
      }));

      const items = result.Items ?? [];

      // 集計
      let totalCost = 0;
      const byApiType = {};   // { llm: { total: 0, daily: [...] }, tts: {...}, stt: {...} }
      const byDevice = {};    // { device_abc: { total: 0, llm: 0, tts: 0, stt: 0 }, ... }

      for (const item of items) {
        const sk = item["date#device_id#api_type"] ?? "";
        const parts = sk.split("#");
        const date = parts[0] ?? "";
        const deviceId = parts[1] ?? "";
        const apiType = parts[2] ?? "";
        const cost = Number(item.cost_jpy) || 0;

        totalCost += cost;

        // API種別ごと
        if (!byApiType[apiType]) byApiType[apiType] = { total: 0, daily: [] };
        byApiType[apiType].total += cost;
        byApiType[apiType].daily.push({
          date, device_id: deviceId, cost,
          provider: item.provider, model: item.model,
          tokens_in: item.tokens_in, tokens_out: item.tokens_out,
          tts_characters: item.tts_characters, stt_characters: item.stt_characters,
          requests: item.requests,
        });

        // デバイスごと
        if (!byDevice[deviceId]) byDevice[deviceId] = { total: 0 };
        byDevice[deviceId].total += cost;
        byDevice[deviceId][apiType] = (byDevice[deviceId][apiType] ?? 0) + cost;
      }

      // 為替レート
      let exchangeRate = null;
      try {
        const rateResult = await ddb.send(new GetCommand({
          TableName: EXCHANGE_RATES_TABLE,
          Key: { month, currency: "JPY" },
        }));
        exchangeRate = rateResult.Item ?? null;
      } catch (e) {
        console.error("[ExchangeRate] error:", e);
      }

      return response(200, {
        month,
        total_cost: Math.round(totalCost * 1000) / 1000,
        by_api_type: byApiType,
        by_device: byDevice,
        exchange_rate: exchangeRate,
      });
    }

    // ---- GET /usage/detail ---- 日次詳細（会話ごとのコスト）
    if (method === "GET" && path === "/usage/detail") {
      const ownerId  = event.queryStringParameters?.owner_id  ?? "user_123";
      const deviceId = event.queryStringParameters?.device_id;
      const date     = event.queryStringParameters?.date;
      if (!date) return response(400, { error: "date is required" });

      // device_id指定あり→そのデバイスのみ、省略→全デバイス
      let deviceIds = deviceId ? [deviceId] : [];
      if (!deviceId) {
        const usageResult = await ddb.send(new QueryCommand({
          TableName: USAGE_TABLE,
          KeyConditionExpression: "owner_id = :oid AND begins_with(#sk, :datePrefix)",
          ExpressionAttributeNames: { "#sk": "date#device_id#api_type" },
          ExpressionAttributeValues: { ":oid": ownerId, ":datePrefix": date },
        }));
        const devSet = new Set();
        for (const item of (usageResult.Items ?? [])) {
          const parts = (item["date#device_id#api_type"] ?? "").split("#");
          if (parts[1]) devSet.add(parts[1]);
        }
        deviceIds = devSet.size > 0 ? [...devSet] : ["app"];
      }

      const allItems = [];
      for (const did of deviceIds) {
        const pk = `owner_id#${ownerId}#device_id#${did}`;
        const result = await ddb.send(new QueryCommand({
          TableName: CHAT_LOGS_TABLE,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "owner_id#device_id" },
          ExpressionAttributeValues: { ":pk": pk },
          ScanIndexForward: true,
        }));
        for (const item of (result.Items ?? [])) {
          if (item.timestamp?.startsWith(date)) allItems.push({ ...item, _device_id: did });
        }
      }
      allItems.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
      const dayItems = allItems;

      // 単価キャッシュとレート取得
      await loadPricingCache();
      const month = date.slice(0, 7);
      let usdJpyRate = 150;
      try {
        const rateResult = await ddb.send(new GetCommand({
          TableName: EXCHANGE_RATES_TABLE,
          Key: { month, currency: "JPY" },
        }));
        usdJpyRate = Number(rateResult.Item?.rate) || 150;
      } catch (e) {}

      // user→assistantペアで組み立て（chat-logに保存済みのコストを使用）
      const conversations = [];
      let lastUserContent = null;
      for (const item of dayItems) {
        if (item.role === "user") {
          lastUserContent = item.content;
        } else if (item.role === "assistant") {
          const hasCost = item.cost_total != null;
          let stt, llm, tts, total;
          if (hasCost) {
            stt = { cost: item.cost_stt ?? 0, characters: lastUserContent?.length ?? 0 };
            llm = { cost: item.cost_llm ?? 0, tokens_in: item.llm_tokens_in, tokens_out: item.llm_tokens_out, provider: item.llm_provider, model: item.llm_model };
            tts = { cost: item.cost_tts ?? 0, characters: item.tts_input_units, provider: item.tts_provider, model: item.tts_provider };
            total = item.cost_total;
          } else {
            const costs = calcCostFromLog(item, lastUserContent, usdJpyRate);
            stt = costs.stt; llm = costs.llm; tts = costs.tts; total = costs.total;
          }
          conversations.push({
            timestamp: item.timestamp,
            session_id: item.session_id,
            device_id: item._device_id ?? item.device_id ?? deviceId,
            user_message: lastUserContent,
            assistant_message: item.content,
            character_id: item.character_id ?? "default",
            stt, llm, tts, total,
          });
          lastUserContent = null;
        }
      }

      return response(200, { date, conversations });
    }

    return response(404, { error: "Not found" });

  } catch (err) {
    console.error("[Error]", err);
    return response(500, { error: err?.message ?? "Internal server error" });
  }
};
