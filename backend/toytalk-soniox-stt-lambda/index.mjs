import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const DEVICES_TABLE = "toytalker-devices";

export const handler = async (event) => {
  try {
    const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
    if (!SONIOX_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SONIOX_API_KEY env var" }),
      };
    }

    // Soniox temporary key API
    const url = "https://api.soniox.com/v1/auth/temporary-api-key";

    const body = {
      usage_type: "transcribe_websocket",
      expires_in_seconds: 3600,
      client_reference_id: "toytalk-lambda",
    };

    // Soniox API呼び出しとデバイス設定取得を並列実行
    const deviceId = event.queryStringParameters?.device_id ?? null;

    const [sonioxRes, deviceSettings] = await Promise.all([
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SONIOX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      deviceId ? ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id: deviceId },
      })).catch(() => null) : Promise.resolve(null),
    ]);

    if (!sonioxRes.ok) {
      const text = await sonioxRes.text();
      return {
        statusCode: sonioxRes.status,
        body: JSON.stringify({
          error: "Soniox API error",
          status: sonioxRes.status,
          details: text,
        }),
      };
    }

    const data = await sonioxRes.json();

    const result = { ok: true, ...data };
    if (deviceSettings?.Item) {
      result.backchannel_enabled = deviceSettings.Item.backchannel_enabled !== false;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
