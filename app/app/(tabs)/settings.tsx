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

const SCREEN_WIDTH = Dimensions.get("window").width;

type SettingsScreen = "main" | "stt-select" | "character-list" | "character-edit" | "voice-select" | "version";

type CharacterItem = {
  character_id: string;
  name: string;
  description: string;
  owner_id: string;
  voice_id: string;
  personality_prompt?: string;
};

type VoiceItem = {
  voice_id: string;
  label: string;
  provider: string;
  vendor_id: string;
};

const DEVICE_SETTING_URL = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";
const PROVIDER_ORDER = ["OpenAI", "Google", "Gemini", "ElevenLabs", "FishAudio"];

const PERSONALITY_TEMPLATES = [
  { label: "海賊",   prompt: "あなたは明るく威勢の良い海賊です。「〜でさあ」「〜じゃな」など海賊らしい口調で話してください。" },
  { label: "忍者",   prompt: "あなたは冷静で謙虚な忍者です。「〜にございます」「〜でござる」など忍者らしい口調で話してください。" },
  { label: "博士",   prompt: "あなたは発明好きの博士です。「〜なのじゃ」「なるほど！」など、知識豊富で熱心な口調で話してください。" },
  { label: "魔法使い", prompt: "あなたは不思議な魔法使いです。「〜じゃよ」「ふむふむ」など、神秘的で優しい口調で話してください。" },
  { label: "フリー入力", prompt: "" },
];

export default function Settings() {
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
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ボイス一覧
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem("sttMode");
      if (saved === "local" || saved === "soniox") setSttMode(saved);
    })();
  }, []);

  const handleSttChange = async (value: "local" | "soniox") => {
    setSttMode(value);
    await AsyncStorage.setItem("sttMode", value);
    navigateTo("main", "back");
  };

  // ---- キャラクター一覧 ----
  const loadCharacters = async () => {
    setCharsLoading(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/characters`);
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
    setSelectedTemplate(null);
    navigateTo("character-edit");
    loadVoices();
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
          body: JSON.stringify({ name: charName.trim(), description: charDesc.trim(), personality_prompt: charPrompt.trim(), voice_id: charVoiceId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        // 新規作成
        const res = await fetch(`${DEVICE_SETTING_URL}/characters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: charName.trim(), description: charDesc.trim(), personality_prompt: charPrompt.trim(), voice_id: charVoiceId }),
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

  // ---- バージョン情報画面 ----
  if (screen === "version") {
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigateTo("main", "back")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>バージョン情報</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          {[
            { ver: "0.7.0", date: "20260309", desc: "キャラクターシステム追加" },
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
          <TouchableOpacity onPress={() => navigateTo("main", "back")}>
            <Text style={s.back}>← 戻る</Text>
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

  const voiceSections = PROVIDER_ORDER
    .map((provider) => ({ title: provider, data: voices.filter((v) => v.provider === provider) }))
    .filter((sec) => sec.data.length > 0);

  const currentVoiceLabel = () => {
    const v = voices.find((v) => v.voice_id === charVoiceId);
    return v ? `${v.label} (${v.provider})` : charVoiceId;
  };

  // ---- ボイス選択画面 ----
  if (screen === "voice-select") {
    return (
      <SafeAreaView style={s.root}>
        <Animated.View style={[s.flex, { transform: [{ translateX: slideAnim }] }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => navigateTo("character-edit", "back")}>
              <Text style={s.back}>← 戻る</Text>
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
          <TouchableOpacity onPress={() => navigateTo("character-list", "back")}>
            <Text style={s.back}>← 戻る</Text>
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

          {/* 削除ボタン（カスタムキャラの編集時のみ） */}
          {editingCharacter && editingCharacter.owner_id !== "system" && (
            <TouchableOpacity
              style={[s.buttonDanger, { marginTop: 32 }, deletingId === editingCharacter.character_id && s.buttonDisabled]}
              onPress={() => deleteCharacter(editingCharacter.character_id)}
              disabled={deletingId === editingCharacter.character_id}
            >
              {deletingId === editingCharacter.character_id
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.buttonText}>削除する</Text>}
            </TouchableOpacity>
          )}

          <TouchableOpacity style={[s.button, saving && s.buttonDisabled, { marginTop: 12 }]} onPress={saveCharacter} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>{editingCharacter ? "保存する" : "作成する"}</Text>}
          </TouchableOpacity>
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
          <TouchableOpacity onPress={() => navigateTo("main", "back")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター管理</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          <TouchableOpacity style={s.button} onPress={() => openCharacterEdit(null)}>
            <Text style={s.buttonText}>＋ キャラクターを作成</Text>
          </TouchableOpacity>

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

          <TouchableOpacity style={s.navRow} onPress={() => {}}>
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
});
