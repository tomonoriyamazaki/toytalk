import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  Pressable,
  Modal,
  findNodeHandle,
  UIManager,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";

type Pos = { x: number; y: number; w: number };
type SettingsScreen = "main" | "character-list" | "character-create";

type CharacterItem = {
  character_id: string;
  name: string;
  description: string;
  owner_id: string;
  voice_id: string;
};

const DEVICE_SETTING_URL = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";

const PERSONALITY_TEMPLATES = [
  { label: "海賊", prompt: "あなたは明るく威勢の良い海賊です。「〜でさあ」「〜じゃな」など海賊らしい口調で話してください。" },
  { label: "忍者", prompt: "あなたは冷静で謙虚な忍者です。「〜にございます」「〜でござる」など忍者らしい口調で話してください。" },
  { label: "博士", prompt: "あなたは発明好きの博士です。「〜なのじゃ」「なるほど！」など、知識豊富で熱心な口調で話してください。" },
  { label: "魔法使い", prompt: "あなたは不思議な魔法使いです。「〜じゃよ」「ふむふむ」など、神秘的で優しい口調で話してください。" },
  { label: "フリー入力", prompt: "" },
];

export default function Settings() {
  const [screen, setScreen] = useState<SettingsScreen>("main");

  // STT設定
  const [sttMode, setSttMode] = useState<"local" | "soniox">("soniox");
  const [modalVisible, setModalVisible] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<Pos | null>(null);
  const selectorRef = useRef<any>(null);

  // キャラクター管理
  const [characters, setCharacters] = useState<CharacterItem[]>([]);
  const [charsLoading, setCharsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // キャラクター作成
  const [charName, setCharName] = useState("");
  const [charDesc, setCharDesc] = useState("");
  const [charPrompt, setCharPrompt] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 起動時に保存値を反映
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem("sttMode");
      if (saved === "local" || saved === "soniox") setSttMode(saved);
    })();
  }, []);

  const openDropdown = () => {
    if (!selectorRef.current) {
      setDropdownPos(null);
      setModalVisible(true);
      return;
    }
    const handle = findNodeHandle(selectorRef.current);
    if (!handle) {
      setDropdownPos(null);
      setModalVisible(true);
      return;
    }

    // @ts-ignore
    const measure = (UIManager.measureInWindow ?? UIManager.measure).bind(UIManager);
    measure(handle, (x: number, y: number, width: number, height: number, pageX?: number, pageY?: number) => {
      const absX = typeof pageX === "number" ? pageX : x;
      const absY = typeof pageY === "number" ? pageY : y;
      const safeW = Number.isFinite(width) && width > 0 ? width : 200;
      const safeX = Number.isFinite(absX) ? absX : 24;
      const safeY = Number.isFinite(absY) ? absY : 24;
      setDropdownPos({ x: safeX, y: safeY + height, w: safeW });
      setModalVisible(true);
    });
  };

  const handleSttChange = async (value: "local" | "soniox") => {
    setSttMode(value);
    await AsyncStorage.setItem("sttMode", value);
    setModalVisible(false);
  };

  const renderDropdown = () => {
    if (!modalVisible) return null;
    const w    = dropdownPos ? Math.max(140, Math.floor(dropdownPos.w * 0.5)) : 220;
    const top  = dropdownPos ? dropdownPos.y : 200;
    const left = dropdownPos ? dropdownPos.x : 24;
    return (
      <Modal transparent visible animationType="fade">
        <Pressable style={s.overlay} onPress={() => setModalVisible(false)}>
          <View style={[s.dropdown, { top, left, width: w }]}>
            <Pressable style={s.option} onPress={() => handleSttChange("soniox")}>
              <Text style={s.optionText}>Soniox STT</Text>
            </Pressable>
            <Pressable style={s.option} onPress={() => handleSttChange("local")}>
              <Text style={s.optionText}>ローカル STT</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    );
  };

  // ---- キャラクター一覧取得 ----
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

  const openCharacterList = () => {
    setScreen("character-list");
    loadCharacters();
  };

  const deleteCharacter = async (characterId: string) => {
    Alert.alert("削除確認", "このキャラクターを削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除", style: "destructive",
        onPress: async () => {
          setDeletingId(characterId);
          try {
            await fetch(`${DEVICE_SETTING_URL}/characters/${encodeURIComponent(characterId)}`, { method: "DELETE" });
            setCharacters((prev) => prev.filter((c) => c.character_id !== characterId));
          } catch {
            Alert.alert("エラー", "削除に失敗しました");
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  // ---- キャラクター作成 ----
  const openCharacterCreate = () => {
    setCharName("");
    setCharDesc("");
    setCharPrompt("");
    setSelectedTemplate(null);
    setScreen("character-create");
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

  const createCharacter = async () => {
    if (!charName.trim()) {
      Alert.alert("エラー", "名前を入力してください");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: charName.trim(),
          description: charDesc.trim(),
          personality_prompt: charPrompt.trim(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setScreen("character-list");
      loadCharacters();
    } catch (e: any) {
      Alert.alert("エラー", "キャラクターの作成に失敗しました");
    } finally {
      setCreating(false);
    }
  };

  // ---- キャラクター作成画面 ----
  if (screen === "character-create") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("character-list")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター作成</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          <Text style={s.sectionTitle}>テンプレート</Text>
          <View style={s.templateRow}>
            {PERSONALITY_TEMPLATES.map((t) => (
              <TouchableOpacity
                key={t.label}
                style={[s.templateChip, selectedTemplate === t.label && s.templateChipSelected]}
                onPress={() => applyTemplate(t.label, t.prompt)}
              >
                <Text style={[s.templateChipText, selectedTemplate === t.label && s.templateChipTextSelected]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[s.sectionTitle, { marginTop: 16 }]}>名前 *</Text>
          <TextInput
            style={s.input}
            value={charName}
            onChangeText={setCharName}
            placeholder="例：海賊ジャック"
            autoCorrect={false}
          />

          <Text style={[s.sectionTitle, { marginTop: 12 }]}>説明</Text>
          <TextInput
            style={s.input}
            value={charDesc}
            onChangeText={setCharDesc}
            placeholder="例：勇敢な海賊キャラクター"
            autoCorrect={false}
          />

          <Text style={[s.sectionTitle, { marginTop: 12 }]}>キャラクタープロンプト</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            value={charPrompt}
            onChangeText={setCharPrompt}
            placeholder="キャラクターの口調・性格を自由に記述..."
            multiline
            numberOfLines={4}
            autoCorrect={false}
          />

          <TouchableOpacity
            style={[s.button, creating && s.buttonDisabled]}
            onPress={createCharacter}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.buttonText}>作成する</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- キャラクター一覧画面 ----
  if (screen === "character-list") {
    const systemChars = characters.filter((c) => c.owner_id === "system");
    const userChars   = characters.filter((c) => c.owner_id !== "system");

    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("main")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター管理</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          <TouchableOpacity style={s.button} onPress={openCharacterCreate}>
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
                    <View key={c.character_id} style={s.characterCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.characterName}>{c.name}</Text>
                        {c.description ? <Text style={s.characterDesc}>{c.description}</Text> : null}
                      </View>
                      <TouchableOpacity
                        onPress={() => deleteCharacter(c.character_id)}
                        disabled={deletingId === c.character_id}
                      >
                        {deletingId === c.character_id ? (
                          <ActivityIndicator size="small" color="#ff3b30" />
                        ) : (
                          <Text style={s.deleteText}>削除</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              )}

              {characters.length === 0 && (
                <Text style={s.emptyText}>キャラクターがありません</Text>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- メイン設定画面 ----
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.wrap}>
        <Text style={s.title}>設定</Text>

        <Text style={s.item}>・音声認識</Text>
        <Pressable ref={selectorRef} style={s.selector} onPress={openDropdown}>
          <Text style={s.selectorText}>
            {sttMode === "local" ? "ローカル STT" : "Soniox STT"}
          </Text>
        </Pressable>

        {renderDropdown()}

        <View style={{ height: 8 }} />
        <Text style={s.item}>・キャラクター管理</Text>
        <TouchableOpacity style={s.navRow} onPress={openCharacterList}>
          <Text style={s.navText}>キャラクターを管理</Text>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>

        <View style={{ height: 32 }} />
        <Text style={s.title}>バージョン</Text>
        <Text style={s.item}>・ver0.7.0   20260309：キャラクターシステム追加</Text>
        <Text style={s.item}>・ver0.6.0   20260306：ボイス追加：ElevenLabs / Fish Audio（※デモ用） </Text>
        <Text style={s.item}>・ver0.5.6   20260210：おもちゃにWIFI設定機能追加</Text>
        <Text style={s.item}>・ver0.5.5   20251005：STT（音声認識）を選択可能にしてリアルタイム表示。スピードも改善</Text>
        <Text style={s.item}>・ver0.4.2   20250907：ボイス追加：Google TTS/Gemini Speech Generation</Text>
        <Text style={s.item}>・ver0.3.0   20250901：マイク機能追加</Text>
        <Text style={s.item}>・ver0.2.0   20250831：会話機能追加。マイクは利用不可</Text>
        <Text style={s.item}>・ver0.1.0   20250830：テストアプリ登録。ホーム/会話/設定画面のみ</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:                    { flex: 1, backgroundColor: "#fff" },
  wrap:                    { padding: 20, gap: 12 },
  title:                   { fontSize: 20, fontWeight: "700" },
  item:                    { fontSize: 16, color: "#444" },
  selector: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    backgroundColor: "#f9f9f9",
    width: "50%",
  },
  selectorText:            { fontSize: 16 },
  overlay:                 { flex: 1 },
  dropdown: {
    position: "absolute",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    elevation: 3,
  },
  option:                  { paddingVertical: 8, paddingHorizontal: 12 },
  optionText:              { fontSize: 16 },
  // キャラクター管理
  navRow:                  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, backgroundColor: "#f9f9f9", borderRadius: 8, borderWidth: 1, borderColor: "#e0e0e0" },
  navText:                 { fontSize: 16, color: "#333" },
  chevron:                 { fontSize: 20, color: "#999" },
  // ヘッダー
  header:                  { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  headerTitle:             { fontSize: 18, fontWeight: "600" },
  back:                    { fontSize: 16, color: "#007AFF" },
  // キャラクター一覧
  listSectionHeader:       { fontSize: 13, fontWeight: "700", color: "#555", marginTop: 16, marginBottom: 6, textTransform: "uppercase" },
  characterCard:           { flexDirection: "row", alignItems: "center", backgroundColor: "#f9f9f9", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0" },
  characterName:           { fontSize: 15, fontWeight: "600" },
  characterDesc:           { fontSize: 12, color: "#888", marginTop: 2 },
  deleteText:              { fontSize: 14, color: "#ff3b30", paddingHorizontal: 8 },
  emptyText:               { fontSize: 15, color: "#999", textAlign: "center", marginTop: 32 },
  // キャラクター作成
  sectionTitle:            { fontSize: 14, fontWeight: "600", color: "#333" },
  templateRow:             { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  templateChip:            { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: "#ccc", backgroundColor: "#f9f9f9" },
  templateChipSelected:    { borderColor: "#007AFF", backgroundColor: "#e8f4ff" },
  templateChipText:        { fontSize: 14, color: "#555" },
  templateChipTextSelected:{ color: "#007AFF", fontWeight: "600" },
  input:                   { backgroundColor: "#fff", padding: 12, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", fontSize: 15, marginTop: 6 },
  inputMultiline:          { height: 100, textAlignVertical: "top" },
  button:                  { backgroundColor: "#007AFF", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonDisabled:          { backgroundColor: "#999" },
  buttonText:              { color: "#fff", fontSize: 16, fontWeight: "600" },
});
