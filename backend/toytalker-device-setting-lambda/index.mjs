// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: なし（DynamoDBはIAMロールで接続）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(client);

// ---- テーブル定義 ----
const DEVICES_TABLE    = "toytalker-devices";
const VOICES_TABLE     = "toytalker-voices";
const CHARACTERS_TABLE = "toytalker-characters";

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
      const { name, description = "", personality_prompt = "", voice_id = "elevenlabs_sameno", owner_id = "user_123" } = body;
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
          created_at: now,
          last_seen: now,
        },
        // すでに存在する場合は created_at を上書きしない
        ConditionExpression: "attribute_not_exists(device_id)",
      })).catch(async (err) => {
        if (err.name === "ConditionalCheckFailedException") {
          // 登録済みなら last_seen だけ更新
          await ddb.send(new UpdateCommand({
            TableName: DEVICES_TABLE,
            Key: { device_id },
            UpdateExpression: "SET last_seen = :t",
            ExpressionAttributeValues: { ":t": now },
          }));
        } else {
          throw err;
        }
      });

      return response(200, { device_id, message: "Device registered" });
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

    // ---- PUT /devices/{device_id} ---- キャラクター設定更新
    if (method === "PUT" && path.startsWith("/devices/")) {
      const device_id = decodeURIComponent(path.split("/")[2]);
      const body      = JSON.parse(event.body ?? "{}");
      const { character_id } = body;
      if (!character_id) return response(400, { error: "character_id is required" });

      await ddb.send(new UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
        UpdateExpression: "SET character_id = :c, last_seen = :t",
        ExpressionAttributeValues: {
          ":c": character_id,
          ":t": new Date().toISOString(),
        },
      }));
      return response(200, { device_id, character_id, message: "Device updated" });
    }

    return response(404, { error: "Not found" });

  } catch (err) {
    console.error("[Error]", err);
    return response(500, { error: err?.message ?? "Internal server error" });
  }
};
