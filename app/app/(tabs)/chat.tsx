import { EventSourcePolyfill } from "event-source-polyfill";
import { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio } from "expo-av";

// デバッグログを見たいとき true
const DEBUG = true;

// ★ あなたの Lambda URL
const STREAM_URL =
  "https://ruc3x2rt3bcnsqxvuyvwdshhh40mzadk.lambda-url.ap-northeast-1.on.aws/";

export default function Chat() {
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const readyRef = useRef(false);

  // 音声はキュー再生（重なり防止）
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);

  useEffect(() => {
    (async () => {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      readyRef.current = true;
    })();
  }, []);

  const enqueueAudio = async (b64: string, id: string, format: string) => {
    const path = `${FileSystem.cacheDirectory}${id}.${format}`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    queueRef.current.push({ uri: path });
    if (!playingRef.current) playLoop();
  };

  const playLoop = async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    try {
      while (queueRef.current.length) {
        const { uri } = queueRef.current.shift()!;
        const { sound } = await Audio.Sound.createAsync({ uri });
        await sound.playAsync();
        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((st) => {
            if (st.isLoaded && st.didJustFinish) {
              resolve();
            }
          });
        });
        await sound.unloadAsync();
      }
    } finally {
      playingRef.current = false;
    }
  };

const send = async () => {
  const t = msg.trim();
  if (!t || !readyRef.current) return;
  setMsg("");
  setLog((L) => [...L, `You: ${t}`]);

  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", STREAM_URL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    // ※ Acceptは付けない（付けても良いが不要）

    // 進捗（ストリーム受信）イベント
    let lastIndex = 0;
    let buffer = "";
    let currentEvent: string | null = null;
    let currentData: string[] = [];

    const flush = () => {
      if (!currentEvent || currentData.length === 0) return;
      const dataStr = currentData.join("\n");

      // 生ログ（event / data）を必ず出す
      setLog((L) => [...L, `event:${currentEvent}, data:${dataStr.slice(0, 200)}`]);

      try {
        if (currentEvent === "delta") {
          const obj = JSON.parse(dataStr);
          const text = obj?.text;
          if (text) setLog((L) => [...L, `ToyTalk: ${text}`]);
        } else if (currentEvent === "tts") {
          const obj = JSON.parse(dataStr);
          const { id, b64, format } = obj || {};
          if (id && b64 && format) enqueueAudio(b64, id, format);
        } else if (currentEvent === "error") {
          setLog((L) => [...L, `Error: ${dataStr}`]);
        }
      } catch (e: any) {
        setLog((L) => [...L, `ParseErr(${currentEvent}): ${e?.message ?? e}`]);
      }

      currentEvent = null;
      currentData = [];
    };

    const processChunk = (chunk: string) => {
      buffer += chunk;

      // 「\n\n」ごとに1レコード
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = record.split("\n");
        for (const line of lines) {
          if (line.startsWith("event:")) {
            if (currentEvent || currentData.length) flush();
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData.push(line.slice(5).trimStart());
          } else {
            // コメントなどは無視
          }
        }
        flush();
      }
    };

    xhr.onprogress = () => {
      // 追加分だけ取り出してパース
      const text = xhr.responseText || "";
      const chunk = text.slice(lastIndex);
      lastIndex = text.length;
      if (chunk) processChunk(chunk);
    };

    xhr.onerror = () => {
      setLog((L) => [...L, `XHR error`]);
    };

    xhr.onload = () => {
      // 念のため末尾に残った分を処理
      const text = xhr.responseText || "";
      const tail = text.slice(lastIndex);
      if (tail) processChunk(tail);
      setLog((L) => [...L, "=== stream done ==="]);
    };

    // 送信開始
    xhr.send(
      JSON.stringify({
        messages: [{ role: "user", content: t }],
        tts: true,
        ttsFormat: "mp3",
        ttsVoice: "alloy",
        emitSegText: true,
      })
    );
  } catch (e: any) {
    setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
  }
};



  return (
    <SafeAreaView style={s.root}>
      <ScrollView style={s.chat}>
        {log.map((l, i) => (
          <Text key={i} style={s.line}>
            {l}
          </Text>
        ))}
      </ScrollView>
      <View style={s.inputRow}>
        <TextInput
          value={msg}
          onChangeText={setMsg}
          placeholder="メッセージを入力…"
          style={s.input}
        />
        <TouchableOpacity style={s.btn} onPress={send}>
          <Text style={s.btnText}>送信</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  chat: { flex: 1, padding: 16 },
  line: { fontSize: 16, marginBottom: 4 },
  inputRow: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderColor: "#eee",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  btn: {
    backgroundColor: "#111",
    paddingHorizontal: 16,
    borderRadius: 12,
    justifyContent: "center",
  },
  btnText: { color: "#fff", fontWeight: "600" },
});
