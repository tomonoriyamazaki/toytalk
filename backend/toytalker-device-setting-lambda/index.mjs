// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// Env: なし（DynamoDBはIAMロールで接続）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(client);

// ---- テーブル定義 ----
const DEVICES_TABLE = "toytalker-devices";
const VOICES_TABLE  = "toytalker-voices";

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
          voice_id: null,
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

    // ---- PUT /devices/{device_id} ---- ボイス設定更新
    if (method === "PUT" && path.startsWith("/devices/")) {
      const device_id = decodeURIComponent(path.split("/")[2]);
      const body      = JSON.parse(event.body ?? "{}");
      const { voice_id } = body;
      if (!voice_id) return response(400, { error: "voice_id is required" });

      await ddb.send(new UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id },
        UpdateExpression: "SET voice_id = :v, last_seen = :t",
        ExpressionAttributeValues: {
          ":v": voice_id,
          ":t": new Date().toISOString(),
        },
      }));
      return response(200, { device_id, voice_id, message: "Device updated" });
    }

    return response(404, { error: "Not found" });

  } catch (err) {
    console.error("[Error]", err);
    return response(500, { error: err?.message ?? "Internal server error" });
  }
};
