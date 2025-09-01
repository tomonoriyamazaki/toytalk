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
  Platform,
  PermissionsAndroid,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio } from "expo-av";
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
  SpeechPartialResultsEvent,
} from "@react-native-voice/voice";

// デバッグログを見たいとき true
const DEBUG = false;
const SHOW_STT_DEBUG_UI = DEBUG;    // ★追加：STTデバッグUIの表示可否

{/* === 追加: STTのpartial/final最小表示 === */}
{SHOW_STT_DEBUG_UI && (                 // ★追加：これで隠す/出す
  <View style={{ marginTop: 12 }}>
    <Text style={s.section}>🎙️ STT</Text>
    <Text style={s.small}>
      {isListening ? "Listening: true" : "Listening: false"}
    </Text>
    <Text style={s.label}>Partial</Text>
    <Text style={s.box}>{partial || "…"}</Text>
    <Text style={s.label}>Final</Text>
    <Text style={s.boxStrong}>{finalText || "…"}</Text>
  </View>
)}


const STREAM_URL =
  "https://ruc3x2rt3bcnsqxvuyvwdshhh40mzadk.lambda-url.ap-northeast-1.on.aws/";

export default function Chat() {
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const readyRef = useRef(false);

  // 音声はキュー再生（重なり防止）
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);

  // finalを1回だけ送るためのガード
  const lastSentRef = useRef<string>("");
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null); // デバウンスタイマ
  const sendingRef = useRef(false);                           // 送信中ガード

  // === 追加: STT用の最小state ===
  const [isListening, setIsListening] = useState(false);
  const [partial, setPartial] = useState(""); // 部分結果
  const [finalText, setFinalText] = useState(""); // 確定結果

  // 入力音声終了制御
  const lastActivityAtRef = useRef<number>(0);           // 直近でpartial/finalが来た時刻
  const inactivityTimerRef = useRef<NodeJS.Timeout|null>(null);
  const INACT_MS = 900;         // 無音・更新停止の待ち時間(ms) 最小でOK

  useEffect(() => {
    (async () => {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX,
        interruptionModeAndroid: Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      readyRef.current = true;
    })();
  }, []);

  // === 追加: Androidマイク許可（最小） ===
  const ensureMicPermission = async () => {
    if (Platform.OS !== "android") return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  // === 追加: Voiceイベント（最小） ===
  useEffect(() => {
    Voice.onSpeechStart = () => {
      setIsListening(true);
      setPartial("");
      setFinalText("");
      lastActivityAtRef.current = Date.now();              // ★追加
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
    Voice.onSpeechEnd = () => {
      setIsListening(false);
      // ★話し終わりで送る（finalが空ならpartialでも送る）
      const textToSend = (finalText || partial).trim();
      if (textToSend) {
        // 録音は既に止まっている想定だが念のため
        (async () => { try { await Voice.stop(); } catch {} send(textToSend); })();
      }
    };
    Voice.onSpeechError = (e: SpeechErrorEvent) => {
      setIsListening(false);
      if (DEBUG) {
        setLog((L) => [...L, `STT Error: ${e.error?.message ?? "unknown"}`]);
      }
    };
    Voice.onSpeechPartialResults = (e: SpeechPartialResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      if (text) setPartial(text);
      lastActivityAtRef.current = Date.now();              // ★追加
    };
    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      setFinalText(text);
      setPartial("");
      lastActivityAtRef.current = Date.now();              // ★追加
    };
    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, []);

  // finalTextが更新されても、録音中は送らない。
  // 録音終了(onSpeechEnd) or 無音INACT_MS経過で送る。
  useEffect(() => {
    const t = finalText.trim();
    if (!t) return;

    // すでに録音が止まっているなら即送る（デバウンス不要）
    if (!isListening) {
      if (t !== lastSentRef.current && !sendingRef.current) {
        lastSentRef.current = t;
        (async () => { try { await Voice.stop(); } catch {} if (DEBUG) setLog(L=>[...L, `AutoSend: ${t}`]); send(t); })();
      }
      return;
    }

    // 録音中なら「無音/更新停止」待ち
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      const quiet = Date.now() - lastActivityAtRef.current >= INACT_MS;
      if (!quiet) return;
      const latest = finalText.trim();
      if (!latest) return;
      if (latest === lastSentRef.current || sendingRef.current) return;

      lastSentRef.current = latest;
      (async () => { try { await Voice.stop(); } catch {} if (DEBUG) setLog(L=>[...L, `AutoSend: ${latest}`]); send(latest); })();
    }, INACT_MS);

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [finalText, isListening]);

  // STT開始/停止
  const startSTT = async () => {
    lastSentRef.current = "";
    if (autoSendTimerRef.current) { clearTimeout(autoSendTimerRef.current); autoSendTimerRef.current = null; }
    if (Platform.OS === "android") {
      const ok = await ensureMicPermission();
      if (!ok) {
        setLog(L => [...L, "STT: マイク権限がありません"]);
        return;
      }
    }
    try {
      const avail = await Voice.isAvailable();            // ★追加
      if (!avail) {
        setLog(L => [...L, "STT: 音声認識がこの端末/設定で利用できません"]);
        return;
      }
      if (DEBUG) setLog(L => [...L, "STT: start(ja-JP)"]);
      await Voice.start("ja-JP", { EXTRA_PARTIAL_RESULTS: true } as any);
    } catch (e: any) {
      setLog(L => [...L, `STT start failed: ${e?.message ?? String(e)}`]); // ★見える化
    }
  };

  const stopSTT = async () => {
    try {
      await Voice.stop();
    } catch {
      // ignore
    }
  };

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

  // もともとの send を少しだけ汎用化（引数テキストを送る）
  const send = async (textArg?: string) => {
    const t = (textArg ?? msg).trim();
    if (!t) return;

    if (sendingRef.current) {                    // ★追加
      if (DEBUG) setLog(L => [...L, "skip: sending in flight"]);
      return;
    }
    sendingRef.current = true;                   // ★追加

    if (DEBUG) setLog(L => [...L, `→ POST ${t}`]);   // ★追加（任意）
    setMsg("");
    setLog((L) => [...L, JSON.stringify({ type: "user", text: t })]);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", STREAM_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      // ※ Acceptは付けない（付けても良いが不要）

      // ★追加：念のためタイムアウト
      xhr.timeout = 30000;

      // 進捗（ストリーム受信）イベント
      let lastIndex = 0;
      let buffer = "";
      let accText = ""; // 文字粒度をここに溜める
      const printedIds = new Set<number | string>(); // 同一 id の再表示防止

      let lastEventType: string | null = null;
      let currentEvent: string | null = null;
      let currentData: string[] = [];

      const flush = () => {
        if (currentData.length === 0 && !currentEvent) return;

        const ev = currentEvent ?? lastEventType ?? "message";
        const dataStr = currentData.join("\n");

        if (DEBUG)
          setLog((L) => [
            ...L,
            `event:${ev}, data:${dataStr.slice(0, 200)}`,
          ]);

        try {
          if (ev === "delta") {
            if (DEBUG) {
              const obj = JSON.parse(dataStr);
              const text: string = obj?.text ?? "";
              if (text) setLog((L) => [...L, `delta: ${text}`]);
            }
          } else if (ev === "segment") {
            const obj = JSON.parse(dataStr);
            const text: string = obj?.text ?? "";
            if (text) setLog((L) => [...L, text]);
          } else if (ev === "tts") {
            const obj = JSON.parse(dataStr);
            const { id, b64, format } = obj || {};
            if (id != null && b64 && format)
              enqueueAudio(b64, String(id), String(format));
            else if (DEBUG)
              setLog((L) => [
                ...L,
                `tts malformed: ${dataStr.slice(0, 120)}`,
              ]);
          } else if (ev === "error") {
            setLog((L) => [...L, `Error: ${dataStr}`]);
          }
        } catch (e: any) {
          setLog((L) => [...L, `ParseErr(${ev}): ${e?.message ?? e}`]);
        }

        lastEventType = ev;
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
        setLog(L => [...L, `XHR error`]);
        sendingRef.current = false;              // ★解除
      };

      xhr.ontimeout = () => {
        setLog(L => [...L, `XHR timeout`]);
        sendingRef.current = false;              // ★解除
      };

      xhr.onload = () => {
        // 念のため末尾に残った分を処理
        const text = xhr.responseText || "";
        const tail = text.slice(lastIndex);
        if (tail) processChunk(tail);

        const out = accText.trim();
        if (out) setLog((L) => [...L, out]);

        if(DEBUG) setLog((L) => [...L, "=== stream done ==="]);
        sendingRef.current = false;              // ★解除
      };

      // 送信開始
      xhr.send(
        JSON.stringify({
          messages: [{ role: "user", content: t }],
          voice: "nova",
        })
      );
    } catch (e: any) {
      setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
      sendingRef.current = false;                // ★解除
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <ScrollView style={s.chat}>
        {log.map((l, i) => {
          let content = l;
          let isUser = false;

          try {
            const obj = JSON.parse(l);
            if (obj.type === "user") {
              content = obj.text;
              isUser = true;
            }
          } catch {}

          if (isUser) {
            return (
              <View key={i} style={s.userBubble}>
                <Text style={s.userBubbleText}>{content}</Text>
              </View>
            );
          } else {
            return (
              <Text key={i} style={s.line}>
                {content}
              </Text>
            );
          }
        })}

        {/* === 追加: STTのpartial/final最小表示 === */}
        {DEBUG && (
          <View style={{ marginTop: 12 }}>
            <Text style={s.section}>🎙️ STT</Text>
            <Text style={s.small}>
              {isListening ? "Listening: true" : "Listening: false"}
            </Text>
            <Text style={s.label}>Partial</Text>
            <Text style={s.box}>{partial || "…"}</Text>
            <Text style={s.label}>Final</Text>
            <Text style={s.boxStrong}>{finalText || "…"}</Text>
          </View>
        )}
      </ScrollView>

      <View style={s.inputRow}>
        <TouchableOpacity
          style={[s.micBtn, { backgroundColor: isListening ? "#b00020" : "#0a7" }]}
          onPress={isListening ? stopSTT : startSTT}
        >
          <Text style={s.btnText}>{isListening ? "停止" : "🎤開始"}</Text>
        </TouchableOpacity>

        <TextInput
          value={msg}
          onChangeText={setMsg}
          placeholder="メッセージを入力…"
          style={s.input}
        />
        <TouchableOpacity style={s.btn} onPress={() => send()}>
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
  section: { fontSize: 16, fontWeight: "600", marginBottom: 6 },
  small: { color: "#666", marginBottom: 6 },
  label: { fontSize: 12, color: "#666", marginTop: 8 },
  box: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 10,
    minHeight: 40,
    fontSize: 16,
  },
  boxStrong: {
    borderWidth: 1,
    borderColor: "#4f46e5",
    borderRadius: 10,
    padding: 10,
    minHeight: 40,
    fontSize: 16,
  },
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
  micBtn: {
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: "center",
  },
  userLine: {
  textAlign: "right",
  color: "#007aff",     // 好きな色に変えてOK
  fontWeight: "500",
  },
  userBubble: {
    alignSelf: "flex-end",         // 右側に寄せる
    backgroundColor: "#007aff",    // 吹き出しの色（iMessage風ブルー）
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    maxWidth: "80%",               // 長文は折り返す
  },
  userBubbleText: {
    color: "#fff",                 // 吹き出し内テキストを白に
    fontSize: 16,
  },
});
