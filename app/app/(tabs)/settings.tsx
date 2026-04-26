import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Animated,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { useOwnerId } from "../../hooks/useOwnerId";

const SCREEN_WIDTH = Dimensions.get("window").width;

type SettingsScreen = "main" | "stt-select" | "character-list" | "character-edit" | "voice-select" | "llm-select" | "version" | "usage" | "usage-detail";

type CharacterItem = {
  character_id: string;
  name: string;
  description: string;
  owner_id: string;
  voice_id: string;
  llm_id?: string;
  personality_prompt?: string;
};

type VoiceItem = {
  voice_id: string;
  label: string;
  provider: string;
  vendor_id: string;
};

type LlmItem = {
  llm_id: string;
  label: string;
  provider: string;
  model_id: string;
};

const DEVICE_SETTING_URL = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";
// プロバイダー一覧はvoicesテーブルから動的に取得

const PERSONALITY_TEMPLATES = [
  { label: "海賊",   prompt: "あなたは明るく威勢の良い海賊です。「〜でさあ」「〜じゃな」など海賊らしい口調で話してください。" },
  { label: "忍者",   prompt: "あなたは冷静で謙虚な忍者です。「〜にございます」「〜でござる」など忍者らしい口調で話してください。" },
  { label: "博士",   prompt: "あなたは発明好きの博士です。「〜なのじゃ」「なるほど！」など、知識豊富で熱心な口調で話してください。" },
  { label: "魔法使い", prompt: "あなたは不思議な魔法使いです。「〜じゃよ」「ふむふむ」など、神秘的で優しい口調で話してください。" },
  { label: "フリー入力", prompt: "" },
];

export default function Settings() {
  const ownerId = useOwnerId();
  const [screen, setScreen] = useState<SettingsScreen>("main");
  const slideAnim = useRef(new Animated.Value(0)).current;

  const navigateTo = (next: SettingsScreen, direction: "forward" | "back" = "forward") => {
    const from = direction === "forward" ? SCREEN_WIDTH : -SCREEN_WIDTH;
    slideAnim.setValue(from);
    setScreen(next);
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 280,
      useNativeDriver: true,
    }).start();
  };

  // STT設定
  const [sttMode, setSttMode] = useState<"local" | "soniox">("soniox");

  // キャラクター管理
  const [characters, setCharacters] = useState<CharacterItem[]>([]);
  const [charsLoading, setCharsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // キャラクター編集（新規作成も兼用）
  const [editingCharacter, setEditingCharacter] = useState<CharacterItem | null>(null); // null = 新規作成
  const [charName, setCharName] = useState("");
  const [charDesc, setCharDesc] = useState("");
  const [charPrompt, setCharPrompt] = useState("");
  const [charVoiceId, setCharVoiceId] = useState("elevenlabs_sameno");
  const [charLlmId, setCharLlmId] = useState("openai_gpt41mini");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ボイス一覧
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);

  // LLM一覧
  const [llms, setLlms] = useState<LlmItem[]>([]);
  const [llmsLoading, setLlmsLoading] = useState(false);

  // 利用状況
  const [usageData, setUsageData] = useState<any>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageMonth, setUsageMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [expandedApi, setExpandedApi] = useState<string | null>(null);
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [usageDetailData, setUsageDetailData] = useState<any>(null);
  const [usageDetailLoading, setUsageDetailLoading] = useState(false);
  const [usageDetailDate, setUsageDetailDate] = useState("");

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem("sttMode");
      if (saved === "local" || saved === "soniox") setSttMode(saved);
    })();
  }, []);

  const loadUsage = async (month: string) => {
    if (!ownerId) return;
    setUsageLoading(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/usage?owner_id=${encodeURIComponent(ownerId)}&month=${month}`);
      const data = await res.json();
      setUsageData(data);
    } catch (e) {
      console.error("[Usage] error:", e);
    } finally {
      setUsageLoading(false);
    }
  };

  const openUsage = () => {
    const month = new Date().toISOString().slice(0, 7);
    setUsageMonth(month);
    setExpandedApi(null);
    setExpandedDevice(null);
    loadUsage(month);
    navigateTo("usage");
  };

  const changeMonth = (delta: number) => {
    const [y, m] = usageMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    setUsageMonth(next);
    setExpandedApi(null);
    setExpandedDevice(null);
    loadUsage(next);
  };

  const formatCost = (v: number) => {
    if (v >= 1) return `${Math.round(v * 10) / 10}`;
    if (v >= 0.01) return v.toFixed(2);
    if (v > 0) return v.toFixed(3);
    return "0";
  };

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split("-");
    return `${y}年${parseInt(m)}月`;
  };

  const API_LABELS: Record<string, string> = { llm: "LLM（言語モデル）", tts: "TTS（音声合成）", stt: "STT（音声認識）" };

  const CHART_COLORS: Record<string, string> = {
    stt: "#34C759", llm: "#007AFF", tts: "#FF9500",
    // プロバイダ別の色
    openai: "#10A37F", google: "#4285F4", gemini: "#886FBF",
    anthropic: "#D97706", elevenlabs: "#F472B6", fishaudio: "#6366F1",
    sakura: "#EC4899", soniox: "#34C759",
  };

  type PieSlice = { label: string; value: number; color: string };

  const PieChart = ({ slices }: { slices: PieSlice[] }) => {
    const total = slices.reduce((s, d) => s + d.value, 0);
    if (total <= 0) return null;
    const filtered = slices.filter(d => d.value > 0).map(d => ({ ...d, pct: d.value / total }));

    return (
      <View style={{ alignItems: "center", marginVertical: 12 }}>
        <Text style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>合計</Text>
        <Text style={{ fontSize: 20, fontWeight: "700", color: "#333", marginBottom: 12 }}>{formatCost(total)}円</Text>
        <View style={{ flexDirection: "row", width: "100%", height: 20, borderRadius: 10, overflow: "hidden", backgroundColor: "#f0f0f0" }}>
          {filtered.map((seg, i) => (
            <View key={i} style={{ flex: seg.pct, backgroundColor: seg.color }} />
          ))}
        </View>
        <View style={s.legendRow}>
          {filtered.map((p, i) => (
            <View key={i} style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: p.color }]} />
              <Text style={s.legendText}>{p.label} {Math.round(p.pct * 100)}% ({formatCost(p.value)}円)</Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  const openUsageDetail = (date: string) => {
    if (!ownerId) return;
    setUsageDetailDate(date);
    setUsageDetailData(null);
    setUsageDetailLoading(true);
    navigateTo("usage-detail");
    if (characters.length === 0) loadCharacters();
    fetch(`${DEVICE_SETTING_URL}/usage/detail?owner_id=${encodeURIComponent(ownerId)}&date=${date}&device_id=app`)
      .then(r => r.json())
      .then(data => setUsageDetailData(data))
      .catch(e => console.error("[UsageDetail] error:", e))
      .finally(() => setUsageDetailLoading(false));
  };

  const handleSttChange = async (value: "local" | "soniox") => {
    setSttMode(value);
    await AsyncStorage.setItem("sttMode", value);
    navigateTo("main", "back");
  };

  // ---- キャラクター一覧 ----
  const loadCharacters = async () => {
    if (!ownerId) return;
    setCharsLoading(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/characters?owner_id=${encodeURIComponent(ownerId)}`);
      const data = await res.json();
      setCharacters(data.characters ?? []);
    } catch {
      Alert.alert("エラー", "キャラクター一覧の取得に失敗しました");
    } finally {
      setCharsLoading(false);
    }
  };

  const loadVoices = async () => {
    setVoicesLoading(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/voices`);
      const data = await res.json();
      setVoices(data.voices ?? []);
    } catch {
      Alert.alert("エラー", "ボイス一覧の取得に失敗しました");
    } finally {
      setVoicesLoading(false);
    }
  };

  const loadLlms = async () => {
    setLlmsLoading(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/llms`);
      const data = await res.json();
      setLlms(data.llms ?? []);
    } catch {
      Alert.alert("エラー", "LLM一覧の取得に失敗しました");
    } finally {
      setLlmsLoading(false);
    }
  };

  const openCharacterList = () => {
    navigateTo("character-list");
    loadCharacters();
  };

  const openCharacterEdit = (character: CharacterItem | null) => {
    setEditingCharacter(character);
    setCharName(character?.name ?? "");
    setCharDesc(character?.description ?? "");
    setCharPrompt(character?.personality_prompt ?? "");
    setCharVoiceId(character?.voice_id ?? "elevenlabs_sameno");
    setCharLlmId(character?.llm_id ?? "openai_gpt41mini");
    setSelectedTemplate(null);
    navigateTo("character-edit");
    loadVoices();
    loadLlms();
  };

  const deleteCharacter = async (characterId: string) => {
    Alert.alert("削除確認", "このキャラクターを削除しますか？\nこの操作は元に戻せません。", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除する", style: "destructive",
        onPress: async () => {
          setDeletingId(characterId);
          try {
            await fetch(`${DEVICE_SETTING_URL}/characters/${encodeURIComponent(characterId)}`, { method: "DELETE" });
            setCharacters((prev) => prev.filter((c) => c.character_id !== characterId));
            navigateTo("character-list", "back");
          } catch {
            Alert.alert("エラー", "削除に失敗しました");
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  const applyTemplate = (label: string, prompt: string) => {
    setSelectedTemplate(label);
    if (label !== "フリー入力") {
      setCharPrompt(prompt);
      if (!charName) setCharName(label);
    } else {
      setCharPrompt("");
    }
  };

  const saveCharacter = async () => {
    if (!charName.trim()) { Alert.alert("エラー", "名前を入力してください"); return; }
    setSaving(true);
    try {
      if (editingCharacter) {
        // 既存キャラ更新
        const res = await fetch(`${DEVICE_SETTING_URL}/characters/${encodeURIComponent(editingCharacter.character_id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: charName.trim(), description: charDesc.trim(), personality_prompt: charPrompt.trim(), voice_id: charVoiceId, llm_id: charLlmId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        // 新規作成
        const res = await fetch(`${DEVICE_SETTING_URL}/characters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: charName.trim(), description: charDesc.trim(), personality_prompt: charPrompt.trim(), voice_id: charVoiceId, llm_id: charLlmId, owner_id: ownerId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      navigateTo("character-list", "back");
      loadCharacters();
    } catch {
      Alert.alert("エラー", "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ---- 利用状況詳細画面（日次） ----
  if (screen === "usage-detail") {
    const convos = usageDetailData?.conversations ?? [];
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => navigateTo("usage", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
              <Text style={s.back}>←</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>{usageDetailDate} の詳細</Text>
          </View>
          <ScrollView contentContainerStyle={s.wrap}>
            {usageDetailLoading ? (
              <ActivityIndicator style={{ marginTop: 32 }} />
            ) : convos.length === 0 ? (
              <Text style={s.emptyText}>この日の会話データはありません</Text>
            ) : (
              <>
                {/* 円グラフ: API種別×プロバイダ */}
                {(() => {
                  const sliceMap: Record<string, { label: string; value: number; color: string }> = {};
                  for (const c of convos) {
                    if (c.stt?.cost) {
                      const key = "STT";
                      if (!sliceMap[key]) sliceMap[key] = { label: key, value: 0, color: CHART_COLORS.stt };
                      sliceMap[key].value += c.stt.cost;
                    }
                    if (c.llm?.cost) {
                      const provider = c.llm.provider ?? "llm";
                      const key = `LLM(${provider})`;
                      if (!sliceMap[key]) sliceMap[key] = { label: key, value: 0, color: CHART_COLORS[provider] ?? CHART_COLORS.llm };
                      sliceMap[key].value += c.llm.cost;
                    }
                    if (c.tts?.cost) {
                      const provider = c.tts.provider ?? "tts";
                      const key = `TTS(${provider})`;
                      if (!sliceMap[key]) sliceMap[key] = { label: key, value: 0, color: CHART_COLORS[provider] ?? CHART_COLORS.tts };
                      sliceMap[key].value += c.tts.cost;
                    }
                  }
                  const slices = Object.values(sliceMap).sort((a, b) => b.value - a.value);
                  return <PieChart slices={slices} />;
                })()}

                {/* 会話ごとの詳細 */}
                {convos.map((c: any, i: number) => {
                  const time = c.timestamp?.slice(11, 19) ?? "";
                  const charName = characters.find(ch => ch.character_id === c.character_id)?.name ?? c.character_id ?? "";
                  const devLabel = usageDetailData?.device_id === "app" ? "アプリ" : (usageDetailData?.device_id ?? "");
                  return (
                    <View key={i} style={s.detailCard}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <Text style={s.detailTime}>{time}</Text>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          {charName ? <Text style={s.detailMeta}>{charName}</Text> : null}
                          {devLabel ? <Text style={s.detailMeta}>{devLabel}</Text> : null}
                        </View>
                      </View>
                      {c.user_message && (
                        <Text style={s.detailUserMsg} numberOfLines={2}>{c.user_message}</Text>
                      )}
                      <View style={s.detailCostList}>
                        {c.stt && (
                          <View style={s.detailCostRow}>
                            <Text style={s.detailCostLabel}>STT</Text>
                            <Text style={s.detailCostSub}>{c.stt.characters}文字</Text>
                            <Text style={s.detailCostValue}>{formatCost(c.stt.cost)} 円</Text>
                          </View>
                        )}
                        {c.llm && (
                          <View style={s.detailCostRow}>
                            <Text style={s.detailCostLabel}>LLM</Text>
                            <Text style={s.detailCostSub}>{c.llm.provider} / in:{c.llm.tokens_in} out:{c.llm.tokens_out}</Text>
                            <Text style={s.detailCostValue}>{formatCost(c.llm.cost)} 円</Text>
                          </View>
                        )}
                        {c.tts && (
                          <View style={s.detailCostRow}>
                            <Text style={s.detailCostLabel}>TTS</Text>
                            <Text style={s.detailCostSub}>{c.tts.provider} / {c.tts.characters}文字</Text>
                            <Text style={s.detailCostValue}>{formatCost(c.tts.cost)} 円</Text>
                          </View>
                        )}
                      </View>
                      <View style={s.detailTotalRow}>
                        <Text style={s.detailTotalLabel}>合計</Text>
                        <Text style={s.detailTotalValue}>{formatCost(c.total)} 円</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- 利用状況画面 ----
  if (screen === "usage") {
    const byApi = usageData?.by_api_type ?? {};
    const byDevice = usageData?.by_device ?? {};
    const rate = usageData?.exchange_rate;

    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => navigateTo("main", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
              <Text style={s.back}>←</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>利用状況</Text>
          </View>
          <ScrollView contentContainerStyle={s.wrap}>
            {/* 月選択 */}
            <View style={s.usageMonthRow}>
              <TouchableOpacity onPress={() => changeMonth(-1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.usageMonthArrow}>←</Text>
              </TouchableOpacity>
              <Text style={s.usageMonthText}>{formatMonthLabel(usageMonth)}</Text>
              <TouchableOpacity onPress={() => changeMonth(1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.usageMonthArrow}>→</Text>
              </TouchableOpacity>
            </View>

            {usageLoading ? (
              <ActivityIndicator style={{ marginTop: 32 }} />
            ) : (
              <>
                {/* 合計 */}
                <View style={s.usageTotalCard}>
                  <Text style={s.usageTotalLabel}>今月の合計</Text>
                  <Text style={s.usageTotalAmount}>{formatCost(usageData?.total_cost ?? 0)} 円</Text>
                </View>

                {/* デバイス別 */}
                {Object.keys(byDevice).length > 0 && (
                  <>
                    <Text style={[s.sectionTitle, { marginTop: 16 }]}>デバイス別</Text>
                    {Object.entries(byDevice).map(([deviceId, info]: [string, any]) => {
                      const isExpanded = expandedDevice === deviceId;
                      return (
                        <TouchableOpacity
                          key={deviceId}
                          style={s.usageApiCard}
                          onPress={() => setExpandedDevice(isExpanded ? null : deviceId)}
                          activeOpacity={0.7}
                        >
                          <View style={s.usageApiHeader}>
                            <Text style={s.usageApiLabel}>{deviceId === "app" ? "アプリ" : deviceId}</Text>
                            <Text style={s.usageApiCost}>{formatCost(info.total)} 円</Text>
                          </View>
                          {isExpanded && (
                            <View style={s.usageDailyList}>
                              {["stt", "llm", "tts"].map((t) =>
                                info[t] ? (
                                  <View key={t} style={s.usageDailyRow}>
                                    <Text style={s.usageDailyDate}>{API_LABELS[t] ?? t}</Text>
                                    <Text style={s.usageDailyCost}>{formatCost(info[t])} 円</Text>
                                  </View>
                                ) : null
                              )}
                            </View>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {/* 日別グラフ */}
                {(() => {
                  const dailyTotals: Record<string, number> = {};
                  for (const apiType of ["stt", "llm", "tts"]) {
                    for (const d of byApi[apiType]?.daily ?? []) {
                      dailyTotals[d.date] = (dailyTotals[d.date] ?? 0) + (d.cost ?? 0);
                    }
                  }
                  const days = Object.entries(dailyTotals).sort((a, b) => a[0].localeCompare(b[0]));
                  if (days.length === 0) return null;
                  const maxCost = Math.max(...days.map(([, c]) => c), 0.001);
                  return (
                    <>
                      <Text style={[s.sectionTitle, { marginTop: 16 }]}>日別</Text>
                      <View style={s.usageApiCard}>
                        {days.map(([date, cost]) => (
                          <TouchableOpacity key={date} style={s.dailyBarRow} onPress={() => openUsageDetail(date)} activeOpacity={0.7}>
                            <Text style={s.dailyBarDate}>{date.slice(8)}日</Text>
                            <View style={s.dailyBarTrack}>
                              <View style={[s.dailyBarFill, { flex: cost / maxCost }]} />
                              <View style={{ flex: 1 - cost / maxCost }} />
                            </View>
                            <Text style={s.dailyBarCost}>{formatCost(cost)} 円</Text>
                            <Text style={s.chevronSmall}>›</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  );
                })()}

                {/* API種別カード */}
                <Text style={[s.sectionTitle, { marginTop: 16 }]}>API種別</Text>
                {["stt", "llm", "tts"].map((apiType) => {
                  const data = byApi[apiType];
                  if (!data) return null;
                  const isExpanded = expandedApi === apiType;
                  const dailyMap: Record<string, { cost: number; requests: number }> = {};
                  for (const d of data.daily ?? []) {
                    if (!dailyMap[d.date]) dailyMap[d.date] = { cost: 0, requests: 0 };
                    dailyMap[d.date].cost += d.cost;
                    dailyMap[d.date].requests += d.requests ?? 0;
                  }
                  const dailySorted = Object.entries(dailyMap).sort((a, b) => a[0].localeCompare(b[0]));

                  return (
                    <TouchableOpacity
                      key={apiType}
                      style={s.usageApiCard}
                      onPress={() => setExpandedApi(isExpanded ? null : apiType)}
                      activeOpacity={0.7}
                    >
                      <View style={s.usageApiHeader}>
                        <Text style={s.usageApiLabel}>{API_LABELS[apiType] ?? apiType.toUpperCase()}</Text>
                        <Text style={s.usageApiCost}>{formatCost(data.total)} 円</Text>
                      </View>
                      {isExpanded && dailySorted.length > 0 && (
                        <View style={s.usageDailyList}>
                          {dailySorted.map(([date, info]) => (
                            <View key={date} style={s.usageDailyRow}>
                              <Text style={s.usageDailyDate}>{date.slice(5)}</Text>
                              <Text style={s.usageDailyRequests}>{info.requests}回</Text>
                              <Text style={s.usageDailyCost}>{formatCost(info.cost)} 円</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}

                {/* 為替レート */}
                {rate && (
                  <Text style={s.usageRateText}>
                    適用レート: 1 USD = {rate.rate} 円（{rate.fetched_at?.slice(0, 10)}）
                  </Text>
                )}

                {usageData?.total_cost === 0 && (
                  <Text style={s.emptyText}>この月の利用データはありません</Text>
                )}
              </>
            )}
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- バージョン情報画面 ----
  if (screen === "version") {
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigateTo("main", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
            <Text style={s.back}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>バージョン情報</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          {[
            { ver: "0.7.1", date: "20260328", desc: "複数デバイスの登録機能追加、他のユーザーの会話が見えてしまう問題を修正" },
            { ver: "0.7.0", date: "20260322", desc: "キャラクターシステム追加、会話ログ機能追加、UI刷新" },
            { ver: "0.6.0", date: "20260306", desc: "ボイス追加：ElevenLabs / Fish Audio（※デモ用）" },
            { ver: "0.5.6", date: "20260210", desc: "おもちゃにWIFI設定機能追加" },
            { ver: "0.5.5", date: "20251005", desc: "STT（音声認識）を選択可能にしてリアルタイム表示。スピードも改善" },
            { ver: "0.4.2", date: "20250907", desc: "ボイス追加：Google TTS / Gemini Speech Generation" },
            { ver: "0.3.0", date: "20250901", desc: "マイク機能追加" },
            { ver: "0.2.0", date: "20250831", desc: "会話機能追加。マイクは利用不可" },
            { ver: "0.1.0", date: "20250830", desc: "テストアプリ登録。ホーム/会話/設定画面のみ" },
          ].map((v) => (
            <View key={v.ver} style={s.versionRow}>
              <View style={s.versionBadge}>
                <Text style={s.versionBadgeText}>v{v.ver}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.versionDate}>{v.date}</Text>
                <Text style={s.versionDesc}>{v.desc}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- STT 選択画面 ----
  if (screen === "stt-select") {
    const STT_OPTIONS = [
      {
        value: "soniox" as const,
        label: "Soniox STT",
        description: "デフォルトで推奨。クラウドベースの高精度な音声認識で多言語に対応。高速なリアルタイム文字起こしができます。",
      },
      {
        value: "local" as const,
        label: "ローカル STT",
        description: "端末内で処理するオフライン音声認識で日本語のみ対応。ネットワーク不要で動作します。",
      },
    ];

    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigateTo("main", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
            <Text style={s.back}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>音声認識</Text>
        </View>
        <View style={s.wrap}>
          {STT_OPTIONS.map((opt) => {
            const selected = sttMode === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[s.sttOption, selected && s.sttOptionSelected]}
                onPress={() => handleSttChange(opt.value)}
              >
                <View style={s.sttOptionRow}>
                  <View style={[s.radio, selected && s.radioSelected]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.sttLabel, selected && s.sttLabelSelected]}>{opt.label}</Text>
                    <Text style={s.sttDesc}>{opt.description}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  const providerOrder = [...new Set(voices.map((v) => v.provider))];
  const voiceSections = providerOrder
    .map((provider) => ({ title: provider, data: voices.filter((v) => v.provider === provider) }))
    .filter((sec) => sec.data.length > 0);

  const currentVoiceLabel = () => {
    const v = voices.find((v) => v.voice_id === charVoiceId);
    return v ? `${v.label} (${v.provider})` : charVoiceId;
  };

  const currentLlmLabel = () => {
    const l = llms.find((l) => l.llm_id === charLlmId);
    return l ? l.label : charLlmId;
  };

  // ---- LLM選択画面 ----
  if (screen === "llm-select") {
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => navigateTo("character-edit", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
              <Text style={s.back}>←</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>LLM選択</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
            {llmsLoading ? (
              <ActivityIndicator size="large" color="#007AFF" style={{ marginTop: 24 }} />
            ) : (
              [...new Set(llms.map((l) => l.provider))].map((provider) => (
                <View key={provider}>
                  <Text style={s.listSectionHeader}>{provider}</Text>
                  {llms.filter((l) => l.provider === provider).map((l) => {
                    const selected = l.llm_id === charLlmId;
                    return (
                      <TouchableOpacity
                        key={l.llm_id}
                        style={[s.voiceRow, selected && s.voiceRowSelected]}
                        onPress={() => { setCharLlmId(l.llm_id); navigateTo("character-edit", "back"); }}
                      >
                        <View style={[s.radio, selected && s.radioSelected]} />
                        <Text style={[s.voiceLabel, selected && s.voiceLabelSelected]}>{l.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))
            )}
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- ボイス��択画面 ----
  if (screen === "voice-select") {
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => navigateTo("character-edit", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
              <Text style={s.back}>←</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>ボイス選択</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
            {voiceSections.map((section) => (
              <View key={section.title}>
                <Text style={s.listSectionHeader}>{section.title}</Text>
                {section.data.map((v) => {
                  const selected = v.voice_id === charVoiceId;
                  return (
                    <TouchableOpacity
                      key={v.voice_id}
                      style={[s.voiceRow, selected && s.voiceRowSelected]}
                      onPress={() => { setCharVoiceId(v.voice_id); navigateTo("character-edit", "back"); }}
                    >
                      <View style={[s.radio, selected && s.radioSelected]} />
                      <Text style={[s.voiceLabel, selected && s.voiceLabelSelected]}>{v.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- キャラクター編集画面 ----
  if (screen === "character-edit") {

    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigateTo("character-list", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
            <Text style={s.back}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>{editingCharacter ? "キャラクター編集" : "キャラクター作成"}</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">

          <Text style={s.sectionTitle}>テンプレート</Text>
          <View style={s.templateRow}>
            {PERSONALITY_TEMPLATES.map((t) => (
              <TouchableOpacity
                key={t.label}
                style={[s.templateChip, selectedTemplate === t.label && s.templateChipSelected]}
                onPress={() => applyTemplate(t.label, t.prompt)}
              >
                <Text style={[s.templateChipText, selectedTemplate === t.label && s.templateChipTextSelected]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[s.sectionTitle, { marginTop: 16 }]}>名前 *</Text>
          <TextInput style={s.input} value={charName} onChangeText={setCharName} placeholder="例：海賊ジャック" autoCorrect={false} />

          <Text style={[s.sectionTitle, { marginTop: 12 }]}>説明</Text>
          <TextInput style={s.input} value={charDesc} onChangeText={setCharDesc} placeholder="例：勇敢な海賊キャラクター" autoCorrect={false} />

          <Text style={[s.sectionTitle, { marginTop: 12 }]}>性格・口調</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            value={charPrompt}
            onChangeText={setCharPrompt}
            placeholder="キャラクターの性格や口調を自由に記述..."
            multiline
            numberOfLines={4}
            autoCorrect={false}
          />

          <Text style={[s.sectionTitle, { marginTop: 16 }]}>ボイス</Text>
          <TouchableOpacity style={s.settingRow} onPress={() => navigateTo("voice-select")}>
            <Text style={s.settingRowText}>{voicesLoading ? "読み込み中..." : currentVoiceLabel()}</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>

          <Text style={[s.sectionTitle, { marginTop: 16 }]}>LLM</Text>
          <TouchableOpacity style={s.settingRow} onPress={() => navigateTo("llm-select")}>
            <Text style={s.settingRowText}>{llmsLoading ? "読み込み中..." : currentLlmLabel()}</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.button, saving && s.buttonDisabled, { marginTop: 32 }]} onPress={saveCharacter} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>{editingCharacter ? "保存する" : "作成する"}</Text>}
          </TouchableOpacity>

          {/* 削除ボタン（カスタムキャラの編集時のみ） */}
          {editingCharacter && editingCharacter.owner_id !== "system" && (
            <TouchableOpacity
              style={[s.buttonDanger, { marginTop: 12 }, deletingId === editingCharacter.character_id && s.buttonDisabled]}
              onPress={() => deleteCharacter(editingCharacter.character_id)}
              disabled={deletingId === editingCharacter.character_id}
            >
              {deletingId === editingCharacter.character_id
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.buttonText}>削除する</Text>}
            </TouchableOpacity>
          )}
        </ScrollView>

        </KeyboardAvoidingView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- キャラクター一覧画面 ----
  if (screen === "character-list") {
    const systemChars = characters.filter((c) => c.owner_id === "system");
    const userChars   = characters.filter((c) => c.owner_id !== "system");

    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigateTo("main", "back")} hitSlop={{ top: 12, bottom: 12, left: 12, right: 24 }}>
            <Text style={s.back}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター管理</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          {charsLoading ? (
            <ActivityIndicator size="large" color="#007AFF" style={{ marginTop: 24 }} />
          ) : (
            <>
              {systemChars.length > 0 && (
                <>
                  <Text style={s.listSectionHeader}>システム</Text>
                  {systemChars.map((c) => (
                    <View key={c.character_id} style={s.characterCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.characterName}>{c.name}</Text>
                        {c.description ? <Text style={s.characterDesc}>{c.description}</Text> : null}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {userChars.length > 0 && (
                <>
                  <Text style={s.listSectionHeader}>カスタム</Text>
                  {userChars.map((c) => (
                    <TouchableOpacity key={c.character_id} style={s.characterCard} onPress={() => openCharacterEdit(c)}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.characterName}>{c.name}</Text>
                        {c.description ? <Text style={s.characterDesc}>{c.description}</Text> : null}
                      </View>
                      <Text style={s.chevron}>›</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {characters.length === 0 && <Text style={s.emptyText}>キャラクターがありません</Text>}
            </>
          )}

          <TouchableOpacity style={[s.button, { marginTop: 24 }]} onPress={() => openCharacterEdit(null)}>
            <Text style={s.buttonText}>＋ キャラクターを作成</Text>
          </TouchableOpacity>
        </ScrollView>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ---- メイン設定画面 ----
  return (
    <SafeAreaView style={s.root}>
      <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <View style={[s.header, { justifyContent: "space-between" }]}>
          <Text style={s.pageTitle}>設定</Text>
          <TouchableOpacity onPress={() => navigateTo("version")}>
            <Text style={s.versionChip}>Version</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          <TouchableOpacity style={s.navRow} onPress={() => {}}>
            <Text style={s.navText}>アカウント情報</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.navRow} onPress={() => navigateTo("stt-select")}>
            <Text style={s.navText}>音声認識</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.navRow} onPress={openCharacterList}>
            <Text style={s.navText}>キャラクター管理</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.navRow} onPress={openUsage}>
            <Text style={s.navText}>利用状況</Text>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:                    { flex: 1, backgroundColor: "#fff" },
  flex:                    { flex: 1 },
  wrap:                    { padding: 20, gap: 12 },
  pageTitle:               { fontSize: 20, fontWeight: "700" },
  versionChip:             { fontSize: 13, color: "#007AFF", fontWeight: "600", borderWidth: 1, borderColor: "#007AFF", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  // バージョン情報
  versionRow:              { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f0f0f0" },
  versionBadge:            { backgroundColor: "#007AFF", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, minWidth: 56, alignItems: "center" },
  versionBadgeText:        { color: "#fff", fontSize: 12, fontWeight: "700" },
  versionDate:             { fontSize: 12, color: "#999" },
  versionDesc:             { fontSize: 14, color: "#333", marginTop: 2 },
  // STT選択
  sttOption:               { backgroundColor: "#f9f9f9", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0" },
  sttOptionSelected:       { borderColor: "#007AFF", backgroundColor: "#f0f7ff" },
  sttOptionRow:            { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sttLabel:                { fontSize: 16, fontWeight: "600", color: "#333" },
  sttLabelSelected:        { color: "#007AFF" },
  sttDesc:                 { fontSize: 13, color: "#888", marginTop: 4 },
  // ナビゲーション
  navRow:                  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, backgroundColor: "#f9f9f9", borderRadius: 8, borderWidth: 1, borderColor: "#e0e0e0" },
  navText:                 { fontSize: 16, color: "#333" },
  chevron:                 { fontSize: 20, color: "#999" },
  // ヘッダー
  header:                  { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, gap: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  headerTitle:             { fontSize: 18, fontWeight: "600" },
  back:                    { fontSize: 16, color: "#007AFF" },
  // キャラクター一覧
  listSectionHeader:       { fontSize: 13, fontWeight: "700", color: "#555", marginTop: 16, marginBottom: 6, textTransform: "uppercase" },
  characterCard:           { flexDirection: "row", alignItems: "center", backgroundColor: "#f9f9f9", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0", gap: 8 },
  characterName:           { fontSize: 15, fontWeight: "600" },
  characterDesc:           { fontSize: 12, color: "#888", marginTop: 2 },
  editButton:              { paddingHorizontal: 8 },
  editText:                { fontSize: 14, color: "#007AFF" },
  deleteText:              { fontSize: 14, color: "#ff3b30", paddingHorizontal: 8 },
  emptyText:               { fontSize: 15, color: "#999", textAlign: "center", marginTop: 32 },
  // キャラクター編集
  sectionTitle:            { fontSize: 14, fontWeight: "600", color: "#333" },
  templateRow:             { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  templateChip:            { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: "#ccc", backgroundColor: "#f9f9f9" },
  templateChipSelected:    { borderColor: "#007AFF", backgroundColor: "#e8f4ff" },
  templateChipText:        { fontSize: 14, color: "#555" },
  templateChipTextSelected:{ color: "#007AFF", fontWeight: "600" },
  input:                   { backgroundColor: "#fff", padding: 12, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", fontSize: 15, marginTop: 6 },
  inputMultiline:          { height: 100, textAlignVertical: "top" },
  // ボイス選択
  currentVoiceBox:         { backgroundColor: "#f0f7ff", padding: 10, borderRadius: 8, marginTop: 6 },
  currentVoiceText:        { fontSize: 14, color: "#007AFF" },
  voiceRow:                { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 8, marginBottom: 6, backgroundColor: "#f9f9f9", borderWidth: 1, borderColor: "#e0e0e0" },
  voiceRowSelected:        { borderColor: "#007AFF", backgroundColor: "#f0f7ff" },
  radio:                   { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: "#ccc" },
  radioSelected:           { borderColor: "#007AFF", backgroundColor: "#007AFF" },
  voiceLabel:              { fontSize: 14, color: "#333" },
  voiceLabelSelected:      { color: "#007AFF", fontWeight: "600" },
  // ボイス選択行
  settingRow:              { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, backgroundColor: "#f9f9f9", borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0", marginTop: 6 },
  settingRowText:          { fontSize: 15, color: "#333" },
  // ボタン
  button:                  { backgroundColor: "#007AFF", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonDanger:            { backgroundColor: "#ff3b30", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonDisabled:          { backgroundColor: "#999" },
  buttonText:              { color: "#fff", fontSize: 16, fontWeight: "600" },
  // 利用状況
  usageMonthRow:           { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 24, paddingVertical: 8 },
  usageMonthArrow:         { fontSize: 18, color: "#007AFF", fontWeight: "600", paddingHorizontal: 8 },
  usageMonthText:          { fontSize: 18, fontWeight: "700", color: "#333" },
  usageTotalCard:          { backgroundColor: "#f0f7ff", padding: 20, borderRadius: 12, alignItems: "center", borderWidth: 1, borderColor: "#007AFF" },
  usageTotalLabel:         { fontSize: 14, color: "#666" },
  usageTotalAmount:        { fontSize: 32, fontWeight: "800", color: "#007AFF", marginTop: 4 },
  usageApiCard:            { backgroundColor: "#f9f9f9", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0" },
  usageApiHeader:          { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  usageApiLabel:           { fontSize: 15, fontWeight: "600", color: "#333" },
  usageApiCost:            { fontSize: 15, fontWeight: "700", color: "#007AFF" },
  usageDailyList:          { marginTop: 10, borderTopWidth: 1, borderTopColor: "#e0e0e0", paddingTop: 8 },
  usageDailyRow:           { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  usageDailyDate:          { fontSize: 13, color: "#666", flex: 1 },
  usageDailyRequests:      { fontSize: 13, color: "#999", marginRight: 12 },
  usageDailyCost:          { fontSize: 13, fontWeight: "600", color: "#333" },
  usageRateText:           { fontSize: 12, color: "#999", textAlign: "center", marginTop: 16 },
  usageDailyDateLink:      { fontSize: 13, color: "#007AFF", flex: 1 },
  chevronSmall:            { fontSize: 14, color: "#999", marginLeft: 4 },
  dailyBarRow:             { flexDirection: "row", alignItems: "center", paddingVertical: 5 },
  dailyBarDate:            { fontSize: 12, color: "#666", width: 32, textAlign: "right", marginRight: 8 },
  dailyBarTrack:           { flex: 1, flexDirection: "row", height: 14, borderRadius: 7, backgroundColor: "#f0f0f0", overflow: "hidden" },
  dailyBarFill:            { backgroundColor: "#007AFF", borderRadius: 7 },
  dailyBarCost:            { fontSize: 12, color: "#007AFF", width: 58, textAlign: "right", marginLeft: 6 },
  // 利用状況詳細
  detailCard:              { backgroundColor: "#f9f9f9", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0" },
  detailTime:              { fontSize: 14, fontWeight: "700", color: "#333" },
  detailMeta:              { fontSize: 11, color: "#999", backgroundColor: "#f0f0f0", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden" },
  detailUserMsg:           { fontSize: 13, color: "#666", marginTop: 4, fontStyle: "italic" },
  detailCostList:          { marginTop: 8, gap: 4 },
  detailCostRow:           { flexDirection: "row", alignItems: "center" },
  detailCostLabel:         { fontSize: 12, fontWeight: "600", color: "#555", width: 32 },
  detailCostSub:           { fontSize: 11, color: "#999", flex: 1 },
  detailCostValue:         { fontSize: 13, fontWeight: "600", color: "#333" },
  detailTotalRow:          { flexDirection: "row", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#e0e0e0" },
  detailTotalLabel:        { fontSize: 13, fontWeight: "600", color: "#333" },
  detailTotalValue:        { fontSize: 14, fontWeight: "700", color: "#007AFF" },
  // 円グラフ凡例
  legendRow:               { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 12 },
  legendItem:              { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot:               { width: 10, height: 10, borderRadius: 5 },
  legendText:              { fontSize: 11, color: "#666" },
});
