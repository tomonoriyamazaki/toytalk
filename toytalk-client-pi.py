
import requests
import base64
import json
import subprocess
import time
import webrtcvad
import pyaudio
import wave
import collections

API_ENDPOINT = "https://ujh8l09at7.execute-api.ap-northeast-1.amazonaws.com/dev/raspi"
AUDIO_INPUT = "output.mp3"
AUDIO_OUTPUT = "response.aac"
HISTORY = []

def vad_record_to_mp3(output_path="output.mp3", aggressiveness=2, silence_duration=0.7):
    RATE = 48000
    CHANNELS = 1
    FORMAT = pyaudio.paInt16
    FRAME_DURATION = 30  # ms
    FRAME_SIZE = int(RATE * FRAME_DURATION / 1000)
    VAD = webrtcvad.Vad(aggressiveness)

    p = pyaudio.PyAudio()
    stream = p.open(format=FORMAT, channels=CHANNELS, rate=RATE,
                    input=True, frames_per_buffer=FRAME_SIZE)

    ring_buffer = collections.deque(maxlen=int(1000 * silence_duration / FRAME_DURATION))
    triggered = False
    voiced_frames = []

    print("🎤 VAD録音を開始します。喋ってください…")

    while True:
        frame = stream.read(FRAME_SIZE, exception_on_overflow=False)
        is_speech = VAD.is_speech(frame, RATE)

        if not triggered:
            ring_buffer.append((frame, is_speech))
            num_voiced = len([f for f, speech in ring_buffer if speech])
            if num_voiced > 0.9 * ring_buffer.maxlen:
                triggered = True
                voiced_frames.extend([f for f, s in ring_buffer])
                ring_buffer.clear()
                print("🎙️ 録音開始")
        else:
            voiced_frames.append(frame)
            ring_buffer.append((frame, is_speech))
            num_silence = len([f for f, speech in ring_buffer if not speech])
            if num_silence > 0.9 * ring_buffer.maxlen:
                print("⏹️ 録音終了")
                break

    stream.stop_stream()
    stream.close()
    p.terminate()

    temp_wav = "temp.wav"
    wf = wave.open(temp_wav, 'wb')
    wf.setnchannels(CHANNELS)
    wf.setsampwidth(p.get_sample_size(FORMAT))
    wf.setframerate(RATE)
    wf.writeframes(b''.join(voiced_frames))
    wf.close()

    subprocess.run([
        "ffmpeg", "-y",
        "-i", temp_wav,
        "-filter:a", "volume=7",
        output_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

while True:
    print("\n🎤 発話してください（VADで自動検出）...")

    # 1. 録音（VADで可変長）
    vad_record_to_mp3(AUDIO_INPUT)

    # 2. mp3→base64エンコード
    with open(AUDIO_INPUT, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")

    # 3. POST（履歴付き）
    payload = {
        "audio": encoded,
        "history": HISTORY
    }

    try:
        response = requests.post(
            API_ENDPOINT,
            headers={"Content-Type": "application/json"},
            json=payload
        )
        data = response.json()
    except Exception as e:
        print("❌ 通信エラー:", e)
        continue

    # 4. 音声ファイルを保存して再生
    with open(AUDIO_OUTPUT, "wb") as f:
        f.write(base64.b64decode(data["voice"]))

    # 5. テキスト出力
    user_text = data.get("user_text", "")
    assistant_reply = data.get("response_text", "")
    timing = data.get("time", {})

    print(f"\n🧑‍🦱 {user_text}")
    print(f"🤖 {assistant_reply}")

    if timing:
        print("\n⏱️ 処理時間:")
        print(f"  - STT    : {timing.get('stt', '?')} 秒")
        print(f"  - LLM    : {timing.get('llm', '?')} 秒")
        print(f"  - TTS    : {timing.get('tts', '?')} 秒")
        print(f"  - TOTAL  : {timing.get('total', '?')} 秒")

    subprocess.run(["ffplay", "-autoexit", AUDIO_OUTPUT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    if user_text:
        HISTORY.append({"role": "user", "content": user_text})
    if assistant_reply:
        HISTORY.append({"role": "assistant", "content": assistant_reply})

    time.sleep(0.5)
