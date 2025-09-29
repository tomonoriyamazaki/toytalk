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

    // 10分有効 (600秒)
    const body = {
      usage_type: "transcribe_websocket",
      expires_in_seconds: 600,
      client_reference_id: "toytalk-lambda", // 任意
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SONIOX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: res.status,
        body: JSON.stringify({
          error: "Soniox API error",
          status: res.status,
          details: text,
        }),
      };
    }

    const data = await res.json();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
