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

/* === 追加: Soniox用 === */
import AudioRecord from "react-native-audio-record";

/* === Soniox定数 === */
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"; // 公式
const SONIOX_MODEL = "stt-rt-preview";
const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_CHANNELS = 1;
/** あなたのテンポラリーAPIキー発行Lambda。POSTして { ok, api_key } を受け取る想定。 */
const SONIOX_KEY_URL =
  "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

/* === デバッグ === */
const DEBUG = true;
const SHOW_STT_DEBUG_UI = DEBUG;
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

  const [debugTime, setDebugTime] = useState(DEBUG_TIME);
  useEffect(() => {
    DEBUG_TIME = debugTime;
  }, [debugTime]);

  // STTモード
  const [sttMode, setSttMode] = useState<"local" | "soniox">("local");
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const saved = await AsyncStorage.getItem("sttMode");
        setSttMode(saved === "soniox" ? "soniox" : "local");
      })();
    }, [])
  );

  // TTSモデル選択UI（既存）
  const [menuVisible, setMenuVisible] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const pillRef = useRef<View>(null);
  const { width: SCREEN_W } = Dimensions.get("window");

  const [submenuFor, setSubmenuFor] = useState<keyof typeof MODEL_MAP | null>(null);
  const MENU_W = 240;

  const MODEL_MAP = {
    OpenAI: {
      label: "OpenAI",
      desc: "4o-mini-tts",
      defaultVoice: "nova",
      voices: {
        alloy: { label: "Alloy – neutral male", vendorId: "alloy" },
        nova: { label: "Nova – kind female", vendorId: "nova" },
        verse: { label: "Verse – calm narrator", vendorId: "verse" },
      },
    },
    Google: {
      label: "Google",
      desc: "Google TTS",
      defaultVoice: "jaB",
      voices: {
        jaB: { label: "JP-B – soft female", vendorId: "ja-JP-Neural2-B" },
        jaC: { label: "JP-C – soft male", vendorId: "ja-JP-Neural2-C" },
      },
    },
    Gemini: {
      label: "Gemini",
      desc: "2.5 Flash TTS",
      defaultVoice: "leda",
      voices: {
        leda: { label: "Leda – clear female", vendorId: "leda" },
        puck: { label: "Puck – clear male", vendorId: "puck" },
      },
    },
    NijiVoice: {
      label: "Niji Voice",
      desc: "Anime-style",
      defaultVoice: "default",
      voices: {
        default: { label: "Default", vendorId: "niji-default" },
      },
    },
  } as const;

  const [model, setModel] = useState<keyof typeof MODEL_MAP>("OpenAI");
  const [voiceKey, setVoiceKey] = useState<string>(MODEL_MAP[model].defaultVoice as string);

  // 会話履歴
  const historyRef = useRef<Turn[]>([]);
  const curAssistantRef = useRef<string>("");
  const HISTORY_TURNS_TO_SEND = 10;

  // 音声キュー
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);

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

  // ===== 修正: ここから（setLog を安全に使えるようにローカル関数へ） =====
  const forceIOSPlayAndRecordToSpeaker = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true, // PlayAndRecord
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
        staysActiveInBackground: false,
      });
    } catch (e: any) {
      setLog((L) => [...L, `AudioMode(PlayAndRecord) err: ${e?.message ?? e}`]);
    }
  };

  const restoreIOSPlayback = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, // Playback
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      });
    } catch (e: any) {
      setLog((L) => [...L, `AudioMode(Playback) err: ${e?.message ?? e}`]);
    }
  };
  // ===== 修正: ここまで =====

  useEffect(() => {
    (async () => {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, // ←録音オフにしてPlaybackベースに
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      readyRef.current = true;
    })();
  }, []);

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
    if(DEBUG)setLog(L => [...L, "=== startSonioxSTT CALLED ==="]);  
    setLog((L) => [...L, "Soniox STT: start()"]);

    // 権限（Android/iOS 両方確認）
    const okAndroid = await ensureMicPermissionAndroid();
    const okIOS = await ensureMicPermissionIOS();
    if (!okAndroid || !okIOS) {
      setLog((L) => [...L, "STT: マイク権限がありません"]);
      return;
    }

    try {
      // Temp API Key を取得（あなたのLambda）
      const tempKey = await fetchSonioxTempKey(); // 例: "temp:xxxx"
      // WebSocket接続
      const ws = new WebSocket(SONIOX_WS_URL);
      sonioxWsRef.current = ws;

      ws.onopen = () => {
        if(DEBUG)setLog(L => [...L, "Soniox WS: OPEN"]);  
        const cfg = {
          api_key: tempKey,
          model: SONIOX_MODEL,
          audio_format: "pcm_s16le",
          sample_rate: SONIOX_SAMPLE_RATE,
          num_channels: SONIOX_CHANNELS,
          enable_endpoint_detection: true,
          language_hints: ["ja"],
        };
        ws.send(JSON.stringify(cfg));

        // 録音開始（PCMチャンクをbase64で受ける）
        configureAudioRecord();
        AudioRecord.on("data", (b64: string) => {
          if (!sonioxListeningRef.current) return;
          try {
            const ab = base64ToArrayBuffer(b64);
            ws.send(ab); // バイナリ送信
          }  catch (e: any) {
            if (DEBUG) {
              const msg = e && typeof e === "object" && "message" in e
                ? (e as any).message
                : String(e);
              setLog(L => [...L, `Soniox send err: ${msg}`]);
            }
          }

        });
        AudioRecord.start();
        sonioxListeningRef.current = true;

        // iOSの録音カテゴリを「PlayAndRecord + speaker」に強制
        forceIOSPlayAndRecordToSpeaker();
        setTimeout(forceIOSPlayAndRecordToSpeaker, 50);

        // ===== 修正: ユーザーの体感フィードバック（即時トグル） =====
        setIsListening(true);
        // ===============================================
        setPartial("");
        setFinalText("");
        sonioxFinalBufRef.current = "";
        sonioxNonFinalBufRef.current = "";
      };

      ws.onmessage = (ev) => {
        try {
          const data = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
          if (!data) return;

          const tokens: Array<{ text: string; is_final?: boolean }> = data.tokens || [];

          let finalAppended = "";
          let nonFinalCurrent = "";

          for (const t of tokens) {
            const txt = t.text ?? "";
            if (!txt) continue;
            if (t.is_final) {
              finalAppended += txt;
            } else {
              nonFinalCurrent += txt;
            }
          }

          if (finalAppended) {
            sonioxFinalBufRef.current += finalAppended;
            setFinalText(sonioxFinalBufRef.current.trim());
          }
          sonioxNonFinalBufRef.current = nonFinalCurrent;
          setPartial(nonFinalCurrent);

          if (data.finished && DEBUG) {
            setLog((L) => [...L, "Soniox finished"]);
          }
          if (data.error_code) {
            setLog((L) => [...L, `Soniox Error ${data.error_code}: ${data.error_message ?? ""}`]);
          }
        } catch (e: any) {
          if (DEBUG) {
            const msg = e && typeof e === "object" && "message" in e
              ? (e as any).message
              : String(e);
            setLog(L => [...L, `Soniox parse err: ${msg}`]);
          }
        }
      };

      ws.onerror = () => {
        setLog((L) => [...L, `Soniox WS error`]);
      };

      ws.onclose = () => {
        sonioxListeningRef.current = false;
        setIsListening(false);
      };
    } catch (e: any) {
      setLog((L) => [...L, `Soniox start failed: ${e?.message ?? String(e)}`]);
      sonioxListeningRef.current = false;
      setIsListening(false);
    }
  };

  const stopSonioxSTT = async () => {
    setLog(L => [...L, "Soniox STT: stop()"]);

    // 1. 録音停止
    try {
      await AudioRecord.stop();
    } catch (e) {
      setLog(L => [...L, `AudioRecord.stop error: ${String(e)}`]);
    }
    sonioxListeningRef.current = false;

    // 2. WebSocket閉じる
    const ws = sonioxWsRef.current;
    if (ws && ws.readyState === 1) {
      try { ws.send(new Uint8Array(0)); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 150);
    }

    // 3. Playbackに戻す
    try {
      await restoreIOSPlayback();
      setLog(L => [...L, "AudioMode reset to Playback"]);
    } catch (e) {
      setLog(L => [...L, `restoreIOSPlayback error: ${String(e)}`]);
    }

    // 4. 状態リセットと送信
    setIsListening(false);

    const textToSend = (
      sonioxFinalBufRef.current ||
      sonioxNonFinalBufRef.current ||
      partial ||
      finalText
    ).trim();
    if (textToSend) send(textToSend);

    sonioxFinalBufRef.current = "";
    sonioxNonFinalBufRef.current = "";
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
        setLog((L) => [...L, `STT start failed: ${e?.message ?? String(e)}`]);
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
    if(DEBUG)setLog(L => [...L, `enqueueAudio called: id=${id}, format=${format}`]);
    const path = `${FileSystem.cacheDirectory}${id}.${format}`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if(DEBUG)setLog(L => [...L, `enqueueAudio wrote: ${path}`]);   
    queueRef.current.push({ uri: path });
    if (!playingRef.current) playLoop();
  };

  const playLoop = async () => {
    if (DEBUG) setLog(L => [...L, "playLoop START"]);
    if (playingRef.current) return;
    playingRef.current = true;

    try {
      while (queueRef.current.length) {
        const { uri } = queueRef.current.shift()!;
        if (DEBUG) setLog(L => [...L, `playLoop playing: ${uri}`]);

        const { sound } = await Audio.Sound.createAsync({ uri });
        if (DEBUG) setLog(L => [...L, `sound loaded: ${uri}`]);

        await new Promise<void>((resolve) => {
          let finished = false;

          sound.setOnPlaybackStatusUpdate((st) => {
            if (st.isLoaded && st.didJustFinish && !finished) {
              finished = true;
              sound.unloadAsync().then(() => {
                if (DEBUG) setLog(L => [...L, `sound unloaded: ${uri}`]);
                resolve();
              });
            }
          });

          sound.playAsync().then(() => {
            if (DEBUG) setLog(L => [...L, `sound.playAsync called: ${uri}`]);
          });

          // 念のためタイムアウトで解放（2秒後）
          setTimeout(() => {
            if (!finished) {
              sound.unloadAsync().then(() => {
                if (DEBUG) setLog(L => [...L, `sound timeout-unloaded: ${uri}`]);
                resolve();
              });
            }
          }, 2000);
        });
      }
    } catch (e: any) {
      setLog(L => [...L, `playLoop error: ${e?.message ?? e}`]);
    } finally {
      playingRef.current = false;
    }
  };


  // メッセージ送信（既存SSEサーバ）
  const send = async (textArg?: string) => {
    const t = (textArg ?? msg).trim();
    if (!t) return;

    historyRef.current.push({ role: "user", text: t, ts: Date.now() });
    if (DEBUG_HISTORY) setLog((L) => [...L, `🧾 hist +user "${t.slice(0, 40)}"`]);

    if (sendingRef.current) {
      if (DEBUG) setLog((L) => [...L, "skip: sending in flight"]);
      return;
    }
    sendingRef.current = true;

    if (DEBUG) setLog((L) => [...L, `→ POST ${t}`]);
    if (DEBUG_TIME) sendStartAtRef.current = Date.now();
    setMsg("");
    setLog((L) => [...L, JSON.stringify({ type: "user", text: t })]);

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
        if (out) setLog((L) => [...L, out]);
        if (DEBUG) setLog((L) => [...L, "=== stream done ==="]);
        sendingRef.current = false;
      };

      if (DEBUG_TIME) {
        (mtRef.current as any) = {};
        mtSet("reqAt");
      }

      const recentTurns = historyRef.current.slice(-HISTORY_TURNS_TO_SEND);
      const historyMessages = recentTurns.map((t) => ({ role: t.role, content: t.text }));

      const voices = MODEL_MAP[model].voices as any;
      const voiceToSend =
        MODEL_MAP[model].voices[voiceKey]?.vendorId ??
        MODEL_MAP[model].voices[MODEL_MAP[model].defaultVoice].vendorId;

      const payload = {
        model,
        voice: voiceToSend,
        messages: [...historyMessages, { role: "user", content: t }],
      };
      xhr.send(JSON.stringify(payload));
    } catch (e: any) {
      setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
      sendingRef.current = false;
    }
  };

  return (
    <SafeAreaView style={s.root}>
      {/* ヘッダー */}
      <View style={s.header}>
        <TouchableOpacity
          ref={pillRef}
          style={s.modelPill}
          activeOpacity={0.7}
          onPress={() => {
            pillRef.current?.measureInWindow((x, y, w, h) => {
              setAnchor({ x, y, w, h });
              setSubmenuFor(null);
              setMenuVisible(true);
            });
          }}
        >
          <Text style={s.modelPillText}>
            {MODEL_MAP[model].label} ·{" "}
            {MODEL_MAP[model].voices[voiceKey]?.label ??
              MODEL_MAP[model].voices[MODEL_MAP[model].defaultVoice].label}
          </Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => setDebugTime(!debugTime)}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 12,
            backgroundColor: "rgba(0,0,0,0.06)",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: debugTime ? "#b00" : "#333" }}>
            {debugTime ? "Debug:ON" : "Debug:OFF"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* モデル/ボイス選択 */}
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
              {Object.keys(MODEL_MAP).map((k) => {
                const key = k as keyof typeof MODEL_MAP;
                const opt = MODEL_MAP[key];
                const active = submenuFor === key || model === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[s.dropdownItem, active && s.dropdownItemActive]}
                    onPress={() => setSubmenuFor(key)}
                  >
                    <View style={s.dropdownRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.dropdownTitle}>{opt.label}</Text>
                        <Text style={s.dropdownSub}>{opt.desc}</Text>
                      </View>
                      {model === key && <Text style={s.dropdownCheck}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {anchor && submenuFor && (
            <View
              style={[
                s.dropdown,
                {
                  top: anchor.y + anchor.h + 8,
                  left: Math.min(anchor.x + MENU_W + 8, SCREEN_W - MENU_W - 12),
                  width: MENU_W,
                },
              ]}
            >
              {Object.entries(MODEL_MAP[submenuFor].voices).map(([vk, v]) => (
                <TouchableOpacity
                  key={vk}
                  style={[
                    s.dropdownItem,
                    model === submenuFor && voiceKey === vk && s.dropdownItemActive,
                  ]}
                  onPress={() => {
                    setModel(submenuFor);
                    setVoiceKey(vk);
                    setSubmenuFor(null);
                    setMenuVisible(false);
                  }}
                >
                  <View style={s.dropdownRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.dropdownTitle}>{v.label}</Text>
                    </View>
                    {model === submenuFor && voiceKey === vk && (
                      <Text style={s.dropdownCheck}>✓</Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </Modal>

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
    height: 48,
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
