import { EventSourcePolyfill } from "event-source-polyfill";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  PermissionsAndroid,
  Modal,
  Dimensions,
  Pressable,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
  SpeechPartialResultsEvent,
} from "@react-native-voice/voice";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu, Provider } from "react-native-paper";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import AudioRecord from "react-native-audio-record";
import Sound from "react-native-sound";

/* === Soniox定数 === */
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"; // 公式
const SONIOX_MODEL = "stt-rt-v3";
const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_CHANNELS = 1;

/** Soniox temporary key発行Lambda。POSTしてkey idを受け取りセットする */
const SONIOX_KEY_URL =
  "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";


/* === デバッグ === */
const SHOW_STT_DEBUG_UI = DEBUG;
let DEBUG = false;
let DEBUG_TIME = false;

type Turn = { role: "user" | "assistant"; text: string; ts: number };
const DEBUG_HISTORY = false;

/* 既存：あなたのSSEサーバ（LLM→TTS）*/
const STREAM_URL =
  "https://ruc3x2rt3bcnsqxvuyvwdshhh40mzadk.lambda-url.ap-northeast-1.on.aws/";

/* === ユーティリティ === */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binaryString = (global as any).atob
    ? (global as any).atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

export default function Chat() {
  // 時間計測
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const readyRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // セッション管理とウォッチドッグ
  const sonioxSessionRef = useRef(0);  // 起動ごとに +1
  const sonioxWatchRef = useRef<{ 
    firstAudioTimer?: any; 
    serverQuietTimer?: any; 
  } | null>(null);


  const [debugTime, setDebugTime] = useState(DEBUG_TIME);
  useEffect(() => {
    DEBUG_TIME = debugTime;
    DEBUG = debugTime;
  }, [debugTime]);

  // STTモード
  const [sttMode, setSttMode] = useState<"local" | "soniox">("soniox");
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const saved = await AsyncStorage.getItem("sttMode");
        if (saved === "local" || saved === "soniox") setSttMode(saved);
      })();
    }, [])
  );

  // Sonioxキー発行
  const [sonioxKey, setSonioxKey] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        if (sttMode === "soniox" && !sonioxKey) {
          const key = await fetchSonioxTempKey();
          setSonioxKey(key);
          if (DEBUG) setLog(L => [...L, "Soniox temp key fetched"]);
        }
      })();
    }, [sttMode, sonioxKey])
  );


  // キャラクター選択UI
  const [menuVisible, setMenuVisible] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const pillRef = useRef<View>(null);
  const inputRef = useRef<import("react-native").TextInput>(null);
  const { width: SCREEN_W } = Dimensions.get("window");
  const MENU_W = 240;

  type CharacterItem = { character_id: string; name: string; owner_id: string; };
  const [characters, setCharacters] = useState<CharacterItem[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterItem>({ character_id: "default", name: "トイトーカー", owner_id: "system" });

  const DEVICE_SETTING_URL = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";

  // 起動時に保存済みキャラクターを復元
  useEffect(() => {
    AsyncStorage.getItem("selectedCharacter").then((val) => {
      if (val) setSelectedCharacter(JSON.parse(val));
    });
  }, []);

  const selectCharacter = (c: CharacterItem) => {
    setSelectedCharacter(c);
    AsyncStorage.setItem("selectedCharacter", JSON.stringify(c));
    setMenuVisible(false);
    Keyboard.dismiss();
  };

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const res = await fetch(`${DEVICE_SETTING_URL}/characters`);
          const data = await res.json();
          setCharacters(data.characters ?? []);
        } catch {}
      })();
    }, [])
  );

  // 会話履歴
  const historyRef = useRef<Turn[]>([]);
  const curAssistantRef = useRef<string>("");
  const HISTORY_TURNS_TO_SEND = 10;

  // 音声キュー
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);
  const loopBeatRef = useRef(0);  

  // STT共通state
  const [isListening, setIsListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");

  const lastSentRef = useRef<string>("");
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);
  const sendingRef = useRef(false);
  const sttDetectAtRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number>(0);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const INACT_MS = 900;


  const restoreIOSPlayback = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, // マイク完全に解放して再生専用
        staysActiveInBackground: false,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      if(DEBUG)setLog(L => [...L, "AudioMode restored to Playback"]);
    } catch (e: any) {
      if(DEBUG)setLog(L => [...L, `AudioMode(Playback) err: ${e?.message ?? e}`]);
    }
  };


  const ensureMicPermissionAndroid = async () => {
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

  // ===== 追加: iOSでも明示的にマイク権限を確認 =====
  const ensureMicPermissionIOS = async () => {
    if (Platform.OS !== "ios") return true;
    try {
      const { status } = await Audio.requestPermissionsAsync();
      return status === "granted";
    } catch {
      return false;
    }
  };
  // =====

  // 計測
  const mtRef = { current: {} as Record<string, number | undefined> };
  const mtSet = (k: string) => {
    if (DEBUG_TIME) mtRef.current[k] = Date.now();
  };
  const sttStartAtRef = { current: 0 };
  const sendStartAtRef = { current: 0 };
  const mtReport = (appendLog: (f: (L: string[]) => string[]) => void) => {
    if (!DEBUG_TIME) return;
    const m = mtRef.current;
    const REQ_TTFB_ms = m.firstEventAt && m.reqAt ? m.firstEventAt - m.reqAt : undefined;
    const TTS_FIRST_ARRIVE_ms =
      m.firstTtsArriveAt && m.reqAt ? m.firstTtsArriveAt - m.reqAt : undefined;
    const LLM_START_srv_ms = m.srv_llmStart && m.srv_t0 ? m.srv_llmStart - m.srv_t0 : undefined;
    const TTS_FIRST_BYTE_srv_ms =
      m.srv_ttsFirstByte && m.srv_t0 ? m.srv_ttsFirstByte - m.srv_t0 : undefined;

    appendLog((L) => [
      ...L,
      `⏱️ TTFB=${REQ_TTFB_ms}ms, FirstTTS(arrive)=${TTS_FIRST_ARRIVE_ms}ms / srv: LLM=${LLM_START_srv_ms}ms, TTS1B=${TTS_FIRST_BYTE_srv_ms}ms`,
    ]);
  };

  /* === Local STT(既存) === */
  useEffect(() => {
    if (sttMode !== "local") return;

    // 再登録前にクリーンアップ
    Voice.removeAllListeners?.();

    Voice.onSpeechStart = () => {
      setIsListening(true);
      setPartial("");
      setFinalText("");
      if (DEBUG_TIME) sttStartAtRef.current = Date.now();
      lastActivityAtRef.current = Date.now();
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
    Voice.onSpeechEnd = () => {
      setIsListening(false);
      if (DEBUG_TIME && sttDetectAtRef.current != null) {
        const dur = Date.now() - sttDetectAtRef.current;
        setLog((L) => [...L, `⏱️ STT(talk)=${dur}ms`]);
        sttDetectAtRef.current = null;
      }
      const textToSend = (finalText || partial).trim();

      // ローカルSTTで、入力テキストの表示を正す
      setPartial(""); 

      if (textToSend) {
        (async () => {
          try {
            await stopSTT();
          } catch {}
          send(textToSend);
        })();
      }
    };
    Voice.onSpeechError = (e: SpeechErrorEvent) => {
      setIsListening(false);
      setLog((L) => [...L, `STT Error: ${e.error?.message ?? "unknown"}`]);
    };
    Voice.onSpeechPartialResults = (e: SpeechPartialResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      if (text) setPartial(text);
      if (sttDetectAtRef.current == null) sttDetectAtRef.current = Date.now();
      lastActivityAtRef.current = Date.now();
    };
    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      setFinalText(text);
      setPartial("");
      if (DEBUG_TIME && sttStartAtRef.current) {
        const dur = Date.now() - sttStartAtRef.current;
        setLog((L) => [...L, `⏱️ STT=${dur}ms`]);
        sttStartAtRef.current = 0;
      }
      lastActivityAtRef.current = Date.now();
    };
    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, [sttMode]);

  useEffect(() => {
    const t = finalText.trim();
    if (!t) return;

    if (!isListening) {
      setLog(L => [...L, JSON.stringify({ type: "user", text: t })]);
      
      if (t !== lastSentRef.current && !sendingRef.current) {
        lastSentRef.current = t;
        (async () => {
          try {
            await stopSTT();
          } catch {}
          if (DEBUG) setLog((L) => [...L, `AutoSend: ${t}`]);
          send(t);
        })();
      }
      return;
    }

    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      const quiet = Date.now() - lastActivityAtRef.current >= INACT_MS;
      if (!quiet) return;
      const latest = finalText.trim();
      if (!latest) return;
      if (latest === lastSentRef.current || sendingRef.current) return;

      lastSentRef.current = latest;
      (async () => {
        try {
          await stopSTT();
        } catch {}
        if (DEBUG) setLog((L) => [...L, `AutoSend: ${latest}`]);
        send(latest);
      })();
    }, INACT_MS);

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [finalText, isListening]);

  /* === Soniox: リアルタイムWS === */
  const sonioxWsRef = useRef<WebSocket | null>(null);
  const sonioxListeningRef = useRef(false);
  const sonioxFinalBufRef = useRef<string>(""); // final確定の蓄積
  const sonioxNonFinalBufRef = useRef<string>(""); // 非確定の表示用

  const configureAudioRecord = () => {
    AudioRecord.init({
      sampleRate: SONIOX_SAMPLE_RATE,
      channels: SONIOX_CHANNELS,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_RECOGNITION(Android); iOSでは無視される
      wavFile: "", // 生PCMでon('data')を受ける
    });
  };

  const fetchSonioxTempKey = async (): Promise<string> => {
    const res = await fetch(SONIOX_KEY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const js = await res.json();
    if (!res.ok || !js?.api_key) throw new Error("Failed to get Soniox temp key");
    return js.api_key as string;
  };

  const startSonioxSTT = async () => {
    if(DEBUG)setLog(L => [...L, "Soniox STT: start()"]);

    // すでに起動中なら無視（多重起動防止）
    if (sonioxListeningRef.current) {
      setLog(L => [...L, "Soniox already listening – skip"]);
      return;
    }

    // 権限チェック
    const okAndroid = await ensureMicPermissionAndroid();
    const okIOS = await ensureMicPermissionIOS();
    if (!okAndroid || !okIOS) {
      setLog(L => [...L, "STT: マイク権限がありません"]);
      return;
    }

    // 新しいセッションIDを払い出し
    const mySession = ++sonioxSessionRef.current;
    const guard = () => sonioxSessionRef.current === mySession;

    // 旧WSが残っていたら閉じる
    try { sonioxWsRef.current?.close(); } catch {}

    let bytesSent = 0;
    let gotServerMsg = false;

    // 新規WS
    const ws = new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    sonioxWsRef.current = ws;

    // ウォッチドッグ初期化
    if (!sonioxWatchRef.current) sonioxWatchRef.current = {};
    const clearWatch = () => {
      if (sonioxWatchRef.current?.firstAudioTimer) clearTimeout(sonioxWatchRef.current.firstAudioTimer);
      if (sonioxWatchRef.current?.serverQuietTimer) clearTimeout(sonioxWatchRef.current.serverQuietTimer);
      sonioxWatchRef.current = null;
    };

    ws.onopen = async () => {
      if (!guard()) return;


      // サーバへ設定送信（まず設定→次に音声）
      const cfg = {
        api_key: sonioxKey ?? (await fetchSonioxTempKey()),
        model: SONIOX_MODEL,
        audio_format: "pcm_s16le",
        sample_rate: SONIOX_SAMPLE_RATE,
        num_channels: SONIOX_CHANNELS,
        enable_endpoint_detection: true,
        language_hints: ["ja","en"],
      };
      ws.send(JSON.stringify(cfg));
      if(DEBUG)setLog(L => [...L, "Soniox WS: OPEN + cfg sent"]);

      // 録音開始（onopen後に開始）
      configureAudioRecord();
      AudioRecord.on("data", (b64: string) => {
        if (!guard()) return;                   // 古いセッションは無視
        if (!sonioxListeningRef.current) return;

        try {
          const ab = base64ToArrayBuffer(b64);
          const chunk = new Uint8Array(ab);
          ws.readyState === 1 && ws.send(chunk);
          bytesSent += chunk.byteLength;
        } catch (e: any) {
          setLog(L => [...L, `Soniox send err: ${e?.message ?? String(e)}`]);
        }
      });

      try {
        await AudioRecord.start();
        sonioxListeningRef.current = true;
        setIsListening(true);
        setPartial(""); setFinalText("");
        sonioxFinalBufRef.current = ""; sonioxNonFinalBufRef.current = "";
        if(DEBUG)setLog(L => [...L, "AudioRecord started"]);
      } catch (e: any) {
        setIsListening(false);
        setLog(L => [...L, `AudioRecord.start failed: ${e?.message ?? e}`]);
        // 録音開始に失敗したら即終了
        try { ws.close(); } catch {}
        sonioxListeningRef.current = false;
        setIsListening(false);
        return;
      }
    };

    ws.onmessage = (ev) => {
      if (!guard()) return;
      gotServerMsg = true;

      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (!data) return;

        if (data.error_code) {
          // サーバからのエラー（408含む）を正常終了風に処理してセッションを畳む
          setLog(L => [...L, `Soniox Error ${data.error_code}: ${data.error_message ?? ""}`]);
          try { ws.close(); } catch {}
          return;
        }

        const tokens: Array<{ text: string; is_final?: boolean }> = data.tokens || [];
        let nonFinalCurrent = "";
        for (const t of tokens) {
          const txt = t.text ?? "";
          if (!txt) continue;
          // ★ is_final関係なく、常にpartialとして扱う
          // "<end>" はSTT終了シグナルなので破棄
          if (txt.trim() === "<end>") {
            // ★ Sonioxのエンド通知。即座に自分でクローズ
            if (DEBUG) setLog(L => [...L, "Soniox: <end> detected, closing WS"]);
            try { ws.close(); } catch {}
            continue;
          }
          nonFinalCurrent += txt;
        }
        if (nonFinalCurrent.trim()) {
          sonioxNonFinalBufRef.current = nonFinalCurrent;
          setPartial(nonFinalCurrent);
        } else {
          // 空chunkなら破棄せず、最後のpartialを保持したままにする
          if (DEBUG) setLog(L => [...L, "Soniox: skip empty nonFinal"]);
        }
      } catch (e: any) {
        setLog(L => [...L, `Soniox parse err: ${e?.message ?? e}`]);
      }
    };

    ws.onerror = (_e) => {
      if (!guard()) return;
      setLog(L => [...L, "Soniox WS error"]);
    };

    // ws.closeが実行されたとき or サーバー側から想定外にWebSocket通信を切断された時に自動実行される
    ws.onclose = async (e) => {
      if(DEBUG)setLog(L => [...L, `Soniox WS closed: code=${e.code}`]);

      // ★チャット履歴保持のための一時設定
      const leftover = curAssistantRef.current.trim();
      if (leftover) {
        historyRef.current.push({ role: "assistant", text: leftover, ts: Date.now() });
        curAssistantRef.current = "";
      }

      // 録音停止
      try { await AudioRecord.stop(); } catch {}
      try { AudioRecord.removeAllListeners?.(); } catch {}

      // 状態リセット
      sonioxListeningRef.current = false;
      setIsListening(false);

      const partialOnly = sonioxNonFinalBufRef.current.trim();
      if (partialOnly) {
        //会話履歴に表示
        setLog(L => [...L, JSON.stringify({ type: "user", text: partialOnly })]);
        setPartial("");
        if (DEBUG) setLog(L => [...L, `🚀 Send partial-only (fast): ${partialOnly}`]);
        send(partialOnly);
      }
    };
  };


  const stopSonioxSTT = () => {
    if(DEBUG)setLog(L => [...L, "Soniox STT: stop()"]);
    try { sonioxWsRef.current?.close(); } catch {}  
  };


  // STT開始/停止トグル
  const startSTT = async () => {
    if(DEBUG)setLog(L => [...L, "=== startSTT CALLED ==="]);  
    if(DEBUG)setLog((L) => [...L, `sttMode=${sttMode}`]);

    // 二重起動ガード（無反応の原因になりやすいので明示）
    if (isListening) return;

    // iOS録音カテゴリ
    if (Platform.OS === "ios") {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        });
      } catch (e: any) {
        setLog(L => [...L, `Audio.setAudioModeAsync error: ${String(e)}`]); // ★追加
      }
    }

    if (sttMode === "soniox") {
      // 体感フィードバック
      setIsListening(true);
      try {
        await startSonioxSTT();
      } catch (e) {
        setIsListening(false);
        throw e;
      }
      return;
    }

    if (sttMode === "local") {
      lastSentRef.current = "";
      if (autoSendTimerRef.current) {
        clearTimeout(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
      const okAndroid = await ensureMicPermissionAndroid();
      const okIOS = await ensureMicPermissionIOS();
      if (!okAndroid || !okIOS) {
        setLog((L) => [...L, "STT: マイク権限がありません"]);
        return;
      }
      try {
        const avail = await Voice.isAvailable();
        if (!avail) {
          setLog((L) => [...L, "STT: 音声認識がこの端末/設定で利用できません"]);
          return;
        }
        // 体感フィードバック
        setIsListening(true);
        if (DEBUG) setLog((L) => [...L, "STT: start(ja-JP)"]);
        await Voice.start("ja-JP", { EXTRA_PARTIAL_RESULTS: true } as any);
      } catch (e: any) {
        setIsListening(false);
        setLog((L) => [...L, `STT start failed: ${e?.message ?? e}`]);
      }
    }
  };

  const stopSTT = async () => {
    if (sttMode === "soniox") {
      await stopSonioxSTT();
    } else {
      try {
        await Voice.stop();
      } catch {}
    }
    await restoreIOSPlayback();
  };

  /* === 既存: 音声再生キュー/TTS === */
  const enqueueAudio = async (b64: string, id: string, format: string) => {
    if(DEBUG)setLog(L => [...L, `---start--- enqueueAudio called: id=${id}, format=${format}`]);
    const path = `${FileSystem.cacheDirectory}${id}.${format}`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    queueRef.current.push({ uri: path });
    if (DEBUG) setLog(L => [...L, `before playLoop queue length: ${queueRef.current.length}`]);
    if (DEBUG) setLog(L => [...L, `before playLoop playingRef status: ${playingRef.current}`]);
    if (!playingRef.current) {
      if (DEBUG) setLog(L => [...L, "enqueueAudio triggers playLoop"]);
      playLoop();
    } else {
      if (DEBUG) setLog(L => [...L, "enqueueAudio skipped playLoop (already playing)"]);
    }
  };

  const playLoop = async () => {
    console.log("▶️ playLoop START (react-native-sound)");
    if (playingRef.current) {
      console.log("⏩ already playing, return");
      return;
    }
    playingRef.current = true;
    loopBeatRef.current = Date.now();
    try {
      Sound.setCategory("Playback");
      while (queueRef.current.length) {
        const { uri } = queueRef.current.shift()!;
        const path = uri.replace("file://", "");
        console.log(`🎵 dequeued (Sound): ${path}`);
        await new Promise<void>((resolve) => {
          const s = new Sound(path, "", (error) => {
            if (error) {
              console.log("❌ Sound load error:", error);
              resolve();
              return;
            }
            console.log("✅ Sound loaded:", path);
            loopBeatRef.current = Date.now();
            s.play((success) => {
              if (success) console.log("🏁 Finished playing:", path);
              else console.log("⚠️ Playback failed:", path);
              s.release();
              loopBeatRef.current = Date.now();
              resolve();
            });
          });
        });
      }
    } catch (e: any) {
      console.log("💥 playLoop(Sound) error:", e?.message ?? e);
    } finally {
      playingRef.current = false;
      loopBeatRef.current = Date.now();
      console.log("🔚 playLoop FINISHED (Sound)");
      if (queueRef.current.length > 0) {
        console.log("🔄 playLoop restarting (Sound)");
        playLoop();
      } else {
        console.log("🎙️ Auto restart STT after playback");

        const doAutoRestart = async () => {
          if (sendingRef.current) {
            console.log("⏸️ sending in progress, skip auto-restart");
            return;
          }

          if (sttMode === "soniox") {
            startSonioxSTT();
          } else if (sttMode === "local") {
            console.log("🎤 preparing local STT restart");
            try {
              // 🎧 セッション破棄（安全のため）
              await Voice.destroy().catch(() => {});
              await new Promise(res => setTimeout(res, 100)); // 少し待つ

              // 🎙️ リスナーを再登録（重要！）
              Voice.removeAllListeners?.();
              Voice.onSpeechStart = () => {
                setIsListening(true);
                setPartial("");
                setFinalText("");
              };
              Voice.onSpeechEnd = () => {
                setIsListening(false);
                const textToSend = (finalText || partial).trim();
                if (textToSend) send(textToSend);
              };
              Voice.onSpeechResults = (e) => {
                const text = e.value?.[0] ?? "";
                setFinalText(text);
              };
              Voice.onSpeechPartialResults = (e) => {
                const text = e.value?.[0] ?? "";
                setPartial(text);
              };

              // 🎤 再度録音スタート
              await Voice.start("ja-JP", { EXTRA_PARTIAL_RESULTS: true });
              console.log("🎧 Local STT restarted successfully");
            } catch (e) {
              console.log("⚠️ Local STT restart error:", e);
            }
          }
        };

        setTimeout(doAutoRestart, 100); // 再生後1秒待って再開
      }
    }
  };



  // メッセージ送信（既存SSEサーバ）
  const send = async (textArg?: string) => {
    const t = (textArg ?? msg).trim();
    if (!t) return;

    if (DEBUG_HISTORY) setLog((L) => [...L, `🧾 hist +user "${t.slice(0, 40)}"`]);
    if (sendingRef.current) {
      if (DEBUG) setLog((L) => [...L, "skip: sending in flight"]);
      return;
    }
    sendingRef.current = true;

    if (DEBUG) setLog((L) => [...L, `→ POST ${t}`]);
    if (DEBUG_TIME) sendStartAtRef.current = Date.now();
    setMsg("");

    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", STREAM_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 30000;

      let lastIndex = 0;
      let buffer = "";
      let accText = "";
      const printedIds = new Set<string>();
      let lastEventType: string | null = null;
      let currentEvent: string | null = null;
      let currentData: string[] = [];
      let firstEventSeen = false;

      const flush = () => {
        if (currentData.length === 0 && !currentEvent) return;
        const ev = currentEvent ?? lastEventType ?? "message";
        const dataStr = currentData.join("\n");
        if (DEBUG_TIME && !firstEventSeen) {
          firstEventSeen = true;
          mtSet("firstEventAt");
        }

        try {
          if (ev === "ping") {
            if (DEBUG_TIME) {
              const obj = JSON.parse(dataStr);
              (mtRef.current as any).srv_t0 = obj?.t;
            }
          } else if (ev === "mark") {
            if (DEBUG_TIME) {
              const obj = JSON.parse(dataStr);
              if (obj?.k === "llm_start") (mtRef.current as any).srv_llmStart = obj.t;
              if (obj?.k === "tts_first_byte") (mtRef.current as any).srv_ttsFirstByte = obj.t;
            }
          } else if (ev === "tts") {
            if (DEBUG_TIME && !(mtRef.current as any).firstTtsArriveAt) mtSet("firstTtsArriveAt");
            const obj = JSON.parse(dataStr);
            const { id, b64, format } = obj || {};
            if (id != null && b64 && format) {
              const key = `tts:${String(id)}`;
              if (!printedIds.has(key)) {
                printedIds.add(key);
                enqueueAudio(b64, String(id), String(format));
              }
            }
          } else if (ev === "segment") {
            const obj = JSON.parse(dataStr);
            console.log("🛰 segment event:", obj); 
            const text: string = obj?.text ?? "";
            const final: boolean = !!obj?.final;
            const segId = obj?.id != null ? String(obj.id) : null;
            const segKey = segId ? `seg:${segId}` : null;

            if (!segKey || !printedIds.has(segKey)) {
              if (segKey) printedIds.add(segKey);
              if (text) {
                setLog((L) => [...L, text]);
                curAssistantRef.current += text;
              }
            }
            if (final) {
              const whole = curAssistantRef.current.trim();
              if (whole) {
                historyRef.current.push({ role: "assistant", text: whole, ts: Date.now() });
                if (DEBUG_HISTORY)
                  setLog((L) => [...L, `🧾 hist +assistant "${whole.slice(0, 40)}"`]);
              }
              curAssistantRef.current = "";
              console.log("🧾 assistant final segment:", JSON.stringify(whole));
            }
          } else if (ev === "error") {
            setLog((L) => [...L, `Error: ${dataStr}`]);
          } else if (ev === "done") {
            if (DEBUG_TIME) mtReport(setLog);
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
              // コメント無視
            }
          }
          flush();
        }
      };

      xhr.onprogress = () => {
        const text = xhr.responseText || "";
        const chunk = text.slice(lastIndex);
        lastIndex = text.length;
        if (chunk) processChunk(chunk);
      };
      xhr.onerror = () => {
        setLog((L) => [...L, `XHR error`]);
        sendingRef.current = false;
      };
      xhr.ontimeout = () => {
        setLog((L) => [...L, `XHR timeout`]);
        sendingRef.current = false;
      };

      xhr.onload = () => {
        const text = xhr.responseText || "";
        const tail = text.slice(lastIndex);
        if (tail) processChunk(tail);
        const out = accText.trim();
        if (DEBUG) setLog((L) => [...L, "=== stream done ==="]);
        sendingRef.current = false;
      };

      if (DEBUG_TIME) {
        (mtRef.current as any) = {};
        mtSet("reqAt");
      }

      const recentTurns = historyRef.current.slice(-HISTORY_TURNS_TO_SEND);
      const historyMessages = recentTurns.map((t) => ({ role: t.role, content: t.text }));

      const payload = {
        character_id: selectedCharacter.character_id,
        messages: [...historyMessages, { role: "user", content: t }],
      };
      console.log("🚀 payload to Lambda:", JSON.stringify(payload, null, 2));
      xhr.send(JSON.stringify(payload));
    } catch (e: any) {
      setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
      sendingRef.current = false;
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
      {/* ヘッダー */}
      <View style={s.header}>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          ref={pillRef}
          style={s.modelPill}
          activeOpacity={0.7}
          onPress={() => {
            inputRef.current?.blur();
            pillRef.current?.measureInWindow((x, y, w, h) => {
              setAnchor({ x, y, w, h });
              setMenuVisible(true);
            });
          }}
        >
          <Text style={s.modelPillText}>{selectedCharacter.name}</Text>
        </TouchableOpacity>
      </View>

      {/* キャラクター選択 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuVisible(false)} />
          {anchor && (
            <View
              style={[
                s.dropdown,
                {
                  top: anchor.y + anchor.h + 8,
                  left: Math.min(anchor.x, SCREEN_W - MENU_W - 12),
                  width: MENU_W,
                },
              ]}
            >
              <Text style={s.dropdownHeader}>キャラクター</Text>
              {(["system", "custom"] as const).map((group) => {
                const filtered = characters
                  .filter((c) => group === "system" ? c.owner_id === "system" : c.owner_id !== "system")
                  .sort((a, b) => a.character_id === "default" ? -1 : b.character_id === "default" ? 1 : 0);
                if (filtered.length === 0) return null;
                return (
                  <View key={group}>
                    <Text style={s.dropdownSection}>{group === "system" ? "システム" : "カスタム"}</Text>
                    {filtered.map((c) => (
                      <TouchableOpacity
                        key={c.character_id}
                        style={[s.dropdownItem, selectedCharacter.character_id === c.character_id && s.dropdownItemActive]}
                        onPress={() => selectCharacter(c)}
                      >
                        <View style={s.dropdownRow}>
                          <Text style={s.dropdownTitle}>{c.name}</Text>
                          {selectedCharacter.character_id === c.character_id && <Text style={s.dropdownCheck}>✓</Text>}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </Modal>

      <ScrollView
        ref={scrollRef}
        style={s.chat}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          setShowScrollButton(distanceFromBottom > 100);
        }}
        scrollEventThrottle={16}
      >
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
                  <TextInput editable={false} multiline scrollEnabled={false} value={content} style={[s.userBubbleText, { padding: 0 }]} />
                </View>
              );
            } else {
              return (
                <TextInput key={i} editable={false} multiline scrollEnabled={false} value={content} style={s.line} />
              );
            }
          })}
        
      {/* ★ partialを仮バブルで右側にリアルタイム表示 */}
      {partial && !sendingRef.current ? (
        <View style={s.userBubble}>
          <Text style={s.userBubbleText}>{partial}</Text>
        </View>
      ) : null}

        {SHOW_STT_DEBUG_UI && (
          <View style={{ marginTop: 12 }}>
            <Text style={s.section}>🎙️ STT</Text>
            <Text style={s.small}>{isListening ? "Listening: true" : "Listening: false"}</Text>
            <Text style={s.label}>Partial</Text>
            <Text style={s.box}>{partial || "…"}</Text>
            <Text style={s.label}>Final</Text>
            <Text style={s.boxStrong}>{finalText || "…"}</Text>
          </View>
        )}
      </ScrollView>

      <View style={{ height: 0 }}>
        {showScrollButton && (
          <TouchableOpacity
            style={s.scrollToBottomBtn}
            onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            <Text style={s.scrollToBottomText}>↓</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.inputRow}>
        <TouchableOpacity
          style={[s.micBtn, { backgroundColor: isListening ? "#b00020" : "#0a7" }]}
          onPress={isListening ? stopSTT : startSTT}
        >
          <Text style={s.btnText}>{isListening ? "停止" : "🎤開始"}</Text>
        </TouchableOpacity>

        <TextInput
          ref={inputRef}
          value={msg}
          onChangeText={setMsg}
          placeholder="メッセージを入力…"
          style={s.input}
        />
        <TouchableOpacity style={s.btn} onPress={() => send()}>
          <Text style={s.btnText}>送信</Text>
        </TouchableOpacity>
      </View>
      </KeyboardAvoidingView>
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
  scrollToBottomBtn: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  scrollToBottomText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
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
    color: "#007aff",
    fontWeight: "500",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#007aff",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    maxWidth: "80%",
  },
  userBubbleText: {
    color: "#fff",
    fontSize: 16,
  },
  header: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "#eee",
    backgroundColor: "#fff",
  },
  modelPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  modelPillText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
  },
  modalOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalBox: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    width: "70%",
  },
  modalItem: {
    paddingVertical: 12,
  },
  modalItemText: {
    fontSize: 16,
    textAlign: "center",
  },
  modalCancel: {
    marginTop: 12,
    fontSize: 14,
    textAlign: "center",
    color: "#b00",
  },
  overlay: {
    flex: 1,
    backgroundColor: "transparent",
  },
  dropdown: {
    position: "absolute",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 6,
    width: 280,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  dropdownText: {
    fontSize: 16,
  },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dropdownHeader: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    textTransform: "uppercase",
  },
  dropdownSection: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
    textTransform: "uppercase",
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
    marginTop: 4,
  },
  dropdownTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111",
  },
  dropdownSub: {
    marginTop: 2,
    fontSize: 12,
    color: "#6b7280",
  },
  dropdownCheck: {
    fontSize: 16,
    color: "#4f46e5",
    marginLeft: 8,
  },
  dropdownItemActive: {
    backgroundColor: "rgba(79,70,229,0.06)",
    borderRadius: 8,
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: "#eee",
    marginVertical: 6,
  },
});
