import os
import json
import base64
import urllib.request
import urllib.error
import uuid


OPENAI_API_SECRET_KEY = os.environ["OPENAI_API_SECRET_KEY"]
OPENAI_WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions"
OPENAI_TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech"

def lambda_handler(event, context):
    print("Event received:", json.dumps(event))

    try:
        # JSON文字列としてevent["body"]を読み取る
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": cors_headers(),
            "body": json.dumps({"error": "Invalid JSON in request body."})
        }

    # JSONパース後、辞書形式であるか確認（念のため）
    if not isinstance(body, dict):
        return {
            "statusCode": 400,
            "headers": cors_headers(),
            "body": json.dumps({"error": "Request body must be a JSON object."})
        }

    # audioフィールドを取り出してチェック
    audio_base64 = body.get("audio")
    if not audio_base64:
        return {
            "statusCode": 400,
            "headers": cors_headers(),
            "body": json.dumps({"error": "Missing audio data in request."})
        }

    # Base64デコードしてバイナリに
    try:
        audio_binary = base64.b64decode(audio_base64)
    except Exception as e:
        return {
            "statusCode": 400,
            "headers": cors_headers(),
            "body": json.dumps({"error": f"Failed to decode audio: {str(e)}"})
        }

    try:
        # ✨ Step 1: Whisper で音声→テキスト(SST)
        boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
        form_data = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="input.mp3"\r\n'
            f"Content-Type: audio/mpeg\r\n\r\n"
        ).encode("utf-8") + audio_binary + f"\r\n--{boundary}\r\n".encode("utf-8") + \
        b'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n' + \
        f"--{boundary}--\r\n".encode("utf-8")

        req = urllib.request.Request(
            OPENAI_WHISPER_ENDPOINT,
            data=form_data,
            headers={
                "Authorization": f"Bearer {OPENAI_API_SECRET_KEY}",
                "Content-Type": f"multipart/form-data; boundary={boundary}"
            },
            method="POST"
        )

        with urllib.request.urlopen(req) as res:
            whisper_response = json.load(res)
            user_text = whisper_response["text"]

        print("Whisper STT Text:", user_text)

        # ✨ Step 2: ChatGPT応答を取得

        # クライアントから履歴を取得
        history = body.get("history", [])
        print(json.dumps(history, indent=2))

        # 最後のユーザー発話を履歴に追加（Whisperで得たやつ）
        history.append({"role": "user", "content": user_text})

        chat_payload = json.dumps({
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": "あなたは子供にやさしく話しかけるお姉さんのようなAIです。"},
                *history  # ← 会話履歴を展開
            ]
        }).encode("utf-8")

        chat_req = urllib.request.Request(
            OPENAI_CHAT_ENDPOINT,
            data=chat_payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OPENAI_API_SECRET_KEY}"
            },
            method="POST"
        )

        with urllib.request.urlopen(chat_req) as chat_res:
            chat_data = json.load(chat_res)
            response_text = chat_data["choices"][0]["message"]["content"]
        
        print("ChatGPT Response:", response_text)

        # ✨ Step 3: TTS化
        tts_payload = json.dumps({
            "model": "gpt-4o-mini-tts",
            "input": response_text,
            "voice": "nova",
            "response_format": "aac"
        }).encode("utf-8")

        tts_req = urllib.request.Request(
            OPENAI_TTS_ENDPOINT,
            data=tts_payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OPENAI_API_SECRET_KEY}"
            },
            method="POST"
        )

        with urllib.request.urlopen(tts_req) as tts_res:
            audio_bytes = tts_res.read()
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({
                "voice": audio_base64,
                "response_text": response_text,
                "user_text": user_text
            })
        }

    except urllib.error.HTTPError as e:
        error_detail = e.read().decode()
        print("OpenAI API error:", error_detail)
        return {
            "statusCode": e.code,
            "headers": cors_headers(),
            "body": json.dumps({"error": f"OpenAI API error: {error_detail}"})
        }

    except Exception as e:
        print("Unexpected error:", str(e))
        return {
            "statusCode": 500,
            "headers": cors_headers(),
            "body": json.dumps({"error": "Internal server error"})
        }


def cors_headers():
    return {
        "Access-Control-Allow-Origin": "https://toytalk.zakicorp.com",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    }
