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
import { Audio } from "expo-av";
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
  SpeechPartialResultsEvent,
} from "@react-native-voice/voice";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu, Provider } from "react-native-paper";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";


// デバッグログを見たいとき true
const DEBUG = false;
const SHOW_STT_DEBUG_UI = DEBUG;    // ★追加：STTデバッグUIの表示可否
let DEBUG_TIME = false;

// === 会話履歴 ===
type Turn = { role: "user" | "assistant"; text: string; ts: number };
const DEBUG_HISTORY = false;

/* === 追加: STTのpartial/final最小表示 === */
// （このブロックはJSX外なので実行されません。UIに出すなら return 内の DEBUG ブロックを使ってください）

const STREAM_URL =
  "https://ruc3x2rt3bcnsqxvuyvwdshhh40mzadk.lambda-url.ap-northeast-1.on.aws/";



export default function Chat() {
  // 時間計測
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const readyRef = useRef(false);
  
  // デバッグログをスマホ側でon/offする
  const [debugTime, setDebugTime] = useState(DEBUG_TIME);
  useEffect(() => {
    DEBUG_TIME = debugTime;    // ← 画面トグルが変わるたびにグローバルを書き換え
  }, [debugTime]);


  // STTモデル取得
  const [sttMode, setSttMode] = useState<"local" | "soniox">("local");

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const saved = await AsyncStorage.getItem("sttMode");
        if (saved === "local" || saved === "soniox") {
          setSttMode(saved);
        }
      })();
    }, [])
  );


  // TTSモデル選択
  const [menuVisible, setMenuVisible] = useState(false);
  const [anchor, setAnchor] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const pillRef = useRef<View>(null);
  const { width: SCREEN_W } = Dimensions.get("window");

  // メニュー用
  const [submenuFor, setSubmenuFor] =
    useState<keyof typeof MODEL_MAP | null>(null);
  const MENU_W = 240; // 左パネル幅
  

  // TTSモデル定義
  const MODEL_MAP = {
    OpenAI: {
      label: "OpenAI",
      desc: "4o-mini-tts",
      defaultVoice: "nova",
      voices: {
        alloy: { label: "Alloy – neutral male", vendorId: "alloy" },
        nova:  { label: "Nova – kind female",   vendorId: "nova"  },
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
        puck: { label: "Puck – clear male",  vendorId: "puck" },
      },
    },
    NijiVoice: {
      label: "Niji Voice",
      desc: "Anime-style",
      defaultVoice: "default",
      voices: {
        default: { label: "Default", vendorId: "niji-default" }, // 置き石
      },
    },
  } as const;

  const [model, setModel] = useState<keyof typeof MODEL_MAP>("OpenAI");
  const [voiceKey, setVoiceKey] = useState<string>(
    (MODEL_MAP[model].defaultVoice as string)
  );

  // ==== 会話履歴（このセッションのみ保持）====
  const historyRef = useRef<Turn[]>([]);
  const curAssistantRef = useRef<string>(""); // ストリーミング途中のアシスト応答を束ねる
  const HISTORY_TURNS_TO_SEND = 10; // 直近何ターン送るかを指定

  // 音声はキュー再生（重なり防止）
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);

  // finalを1回だけ送るためのガード
  const lastSentRef = useRef<string>("");
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null); // デバウンスタイマ
  const sendingRef = useRef(false);                           // 送信中ガード
  // STT: “最初に音を検知した瞬間” を記録
  const sttDetectAtRef = useRef<number | null>(null);

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

  // 処理時間計測
  const mtRef = { current: {} as Record<string, number | undefined> };
  const mtSet = (k: string) => { if (DEBUG_TIME) mtRef.current[k] = Date.now(); };
  // 計測用の基準時間
  const sttStartAtRef = { current: 0 };
  const sendStartAtRef = { current: 0 };

  // ログ出力（サーバ時刻とクライアント時刻の簡易まとめ）
  const mtReport = (appendLog: (f: (L: string[]) => string[]) => void) => {
    if (!DEBUG_TIME) return;

    const m = mtRef.current;

    const REQ_TTFB_ms =
      m.firstEventAt && m.reqAt ? m.firstEventAt - m.reqAt : undefined;

    const TTS_FIRST_ARRIVE_ms =
      m.firstTtsArriveAt && m.reqAt ? m.firstTtsArriveAt - m.reqAt : undefined;

    // （サーバ側）ping からの相対
    const LLM_START_srv_ms =
      m.srv_llmStart && m.srv_t0 ? m.srv_llmStart - m.srv_t0 : undefined;

    const TTS_FIRST_BYTE_srv_ms =
      m.srv_ttsFirstByte && m.srv_t0 ? m.srv_ttsFirstByte - m.srv_t0 : undefined;

    appendLog(L => [
      ...L,
      `⏱️ TTFB=${REQ_TTFB_ms}ms, FirstTTS(arrive)=${TTS_FIRST_ARRIVE_ms}ms / srv: LLM=${LLM_START_srv_ms}ms, TTS1B=${TTS_FIRST_BYTE_srv_ms}ms`
    ]);
  };


  // === 追加: Voiceイベント（最小） ===
  useEffect(() => {
    if (sttMode !== "local") return; 

    Voice.onSpeechStart = () => {
      setIsListening(true);
      setPartial("");
      setFinalText("");
      if (DEBUG_TIME) sttStartAtRef.current = Date.now();   // ★ STT開始時間計測
      lastActivityAtRef.current = Date.now();              // ★追加
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
    Voice.onSpeechEnd = () => {
      setIsListening(false);
      // “検知→入力終了” の時間をここで確定
      if (DEBUG_TIME && sttDetectAtRef.current != null) {
        const dur = Date.now() - sttDetectAtRef.current;
        setLog(L => [...L, `⏱️ STT(talk)=${dur}ms`]);
        sttDetectAtRef.current = null;
      }
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
      // 音声の“最初の検知”を一回だけ記録（partial が初めて来た瞬間）
      if (sttDetectAtRef.current == null) sttDetectAtRef.current = Date.now();
      lastActivityAtRef.current = Date.now();              // ★追加
    };
    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      setFinalText(text);
      setPartial("");
      if (DEBUG_TIME && sttStartAtRef.current) {            // ★ STT終了時間計測
        const dur = Date.now() - sttStartAtRef.current;
        setLog(L => [...L, `⏱️ STT=${dur}ms`]);
        sttStartAtRef.current = 0;
      }
      lastActivityAtRef.current = Date.now();              // ★追加
    };
    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, [sttMode]);

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

    if(DEBUG_TIME)setLog(L => [...L, `sttMode=${sttMode}`]);

    // soniox STT処理
    if (sttMode === "soniox") {
      startSonioxSTT();
      return;
    }

    // ローカルSTT処理
    if (sttMode === "local") {
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
    }
  };

  const stopSTT = async () => {
    if (sttMode === "soniox") {
      stopSonioxSTT();     // ← ダミーSoniox呼び出し
      return;
    }
    await Voice.stop();
  };
  



  // Soniox専用（今はダミー）
  const startSonioxSTT = () => {
    setLog(L => [...L, "Soniox STT start() 呼ばれた"]);
  };
  const stopSonioxSTT = () => {
    setLog(L => [...L, "Soniox STT stop() 呼ばれた"]);
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
          let firstFrame = true;
          sound.setOnPlaybackStatusUpdate((st) => {
            if (DEBUG_TIME && firstFrame && st.isLoaded && st.isPlaying) {
              firstFrame = false;
              const ftts = Date.now() - sendStartAtRef.current;
              setLog(L => [...L, `⏱️ FTTS=${ftts}ms`]);
            }
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

    // === 会話履歴: user を追加 ===
    historyRef.current.push({ role: "user", text: t, ts: Date.now() });
    if (DEBUG_HISTORY) setLog(L => [...L, `🧾 hist +user "${t.slice(0,40)}"`]);

    if (sendingRef.current) {                    // ★追加
      if (DEBUG) setLog(L => [...L, "skip: sending in flight"]);
      return;
    }
    sendingRef.current = true;                   // ★追加

    if (DEBUG) setLog(L => [...L, `→ POST ${t}`]);   // ★追加（任意）
    if (DEBUG_TIME) sendStartAtRef.current = Date.now();
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
      const printedIds = new Set<string>(); // 同一イベントの重複防止

      let lastEventType: string | null = null;
      let currentEvent: string | null = null;
      let currentData: string[] = [];

      // ★追加：最初のイベントを記録するためのフラグ
      let firstEventSeen = false;

      const flush = () => {
        if (currentData.length === 0 && !currentEvent) return;

        const ev = currentEvent ?? lastEventType ?? "message";
        const dataStr = currentData.join("\n");

        // ★最初のイベント（サーバから何か来た瞬間）
        if (DEBUG_TIME && !firstEventSeen) {
          firstEventSeen = true;
          mtSet("firstEventAt"); // → REQ_TTFB 用
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
              if (obj?.k === "llm_start")      (mtRef.current as any).srv_llmStart   = obj.t;
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
                setLog(L => [...L, text]);                // 画面表示
                curAssistantRef.current += text;          // 束ねる
              }
            }
            if (final) {
              const whole = curAssistantRef.current.trim();
              if (whole) {
                historyRef.current.push({ role: "assistant", text: whole, ts: Date.now() });
                if (DEBUG_HISTORY) setLog(L => [...L, `🧾 hist +assistant "${whole.slice(0,40)}"`]);
              }
              curAssistantRef.current = "";
            }
          } else if (ev === "error") {
            setLog((L) => [...L, `Error: ${dataStr}`]);
          } else if (ev === "done") {
            if (DEBUG_TIME) mtReport(setLog); // サーバ送信完了時点で計測まとめ
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
      if (DEBUG_TIME) { mtRef.current = {}; mtSet("reqAt"); }


      // 送信用のmessagesを履歴から組み立て（直近Nターン＋今回のユーザー発話）
      const recentTurns = historyRef.current.slice(-HISTORY_TURNS_TO_SEND);
      const historyMessages = recentTurns.map(t => ({
        role: t.role,             // "user" | "assistant"
        content: t.text,
      }));

      const voices = MODEL_MAP[model].voices as any;
      const voiceToSend =
        MODEL_MAP[model].voices[voiceKey]?.vendorId
        ?? MODEL_MAP[model].voices[MODEL_MAP[model].defaultVoice].vendorId;

      
      const payload = {
        model,
        voice: voiceToSend,
        messages: [
          ...historyMessages,
          { role: "user", content: t },
        ],
      };
      xhr.send(JSON.stringify(payload));

    } catch (e: any) {
      setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
      sendingRef.current = false;                // ★解除
    }
  };

  return (
    <SafeAreaView style={s.root}>

      {/* ★ ヘッダー */}
      <View style={s.header}>
        <TouchableOpacity
          ref={pillRef}
          style={s.modelPill}
          activeOpacity={0.7}
          onPress={() => {
            pillRef.current?.measureInWindow((x, y, w, h) => {
              setAnchor({ x, y, w, h });
              setSubmenuFor(null);         // ★追加：まだボイスは出さない
              setMenuVisible(true);
            });
          }}
        >
          <Text style={s.modelPillText}>
            {MODEL_MAP[model].label} · {
              MODEL_MAP[model].voices[voiceKey]?.label
                ?? MODEL_MAP[model].voices[MODEL_MAP[model].defaultVoice].label
            }
          </Text>
        </TouchableOpacity>
        {/* ←追加：右寄せ用のスペーサー */}
        <View style={{ flex: 1 }} />

        {/* ←追加：DEBUG_TIME トグル */}
        <TouchableOpacity
          onPress={() => setDebugTime(!debugTime)}
          style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.06)' }}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: debugTime ? '#b00' : '#333' }}>
            {debugTime ? 'Debug:ON' : 'Debug:OFF'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* アンカー付きポップオーバー */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <View style={s.overlay}>
          {/* 背景だけを閉じるボタンにする（メニューは包まない） */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuVisible(false)} />

          {/* ▼ 左パネル：モデル一覧 */}
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
                    onPress={() => setSubmenuFor(key)}   // ここで右パネルを開く
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

          {/* ▼ 右パネル：ボイス一覧（submenuFor が選ばれた時だけ） */}
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
                      {v.desc && <Text style={s.dropdownSub}>{v.desc}</Text>}
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
  top: 0, left: 0, right: 0, bottom: 0,
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
    // 影
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
    color: "#6b7280", // グレー
  },
  dropdownCheck: {
    fontSize: 16,
    color: "#4f46e5",
    marginLeft: 8,
  },
  dropdownItemActive: {
    backgroundColor: "rgba(79,70,229,0.06)", // うっすら強調
    borderRadius: 8,
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: "#eee",
    marginVertical: 6,
  },
});
