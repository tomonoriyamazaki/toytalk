import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  Pressable,
  Modal,
  findNodeHandle,
  UIManager,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";

type Pos = { x: number; y: number; w: number };

export default function Settings() {
  const [sttMode, setSttMode] = useState<"local" | "soniox">("soniox");
  const [modalVisible, setModalVisible] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<Pos | null>(null);
  const selectorRef = useRef<any>(null);

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

    // Modal座標ズレやNaN対策：measureInWindowで取得、最低幅を確保
    // （失敗したら中央にフォールバック）
    // @ts-ignore
    const measure = (UIManager.measureInWindow ?? UIManager.measure).bind(UIManager);

    measure(handle, (x: number, y: number, width: number, height: number, pageX?: number, pageY?: number) => {
      // measure と measureInWindow の引数差分を吸収
      const absX = typeof pageX === "number" ? pageX : x;
      const absY = typeof pageY === "number" ? pageY : y;

      const safeW = Number.isFinite(width) && width > 0 ? width : 200;
      const safeX = Number.isFinite(absX) ? absX : 24;
      const safeY = Number.isFinite(absY) ? absY : 24;

      setDropdownPos({ x: safeX, y: safeY + height, w: safeW });
      setModalVisible(true);
    });
  };

  const handleChange = async (value: "local" | "soniox") => {
    setSttMode(value);
    await AsyncStorage.setItem("sttMode", value);
    setModalVisible(false);
  };

  const renderDropdown = () => {
    if (!modalVisible) return null;

    // 位置が未解決なら画面中央にフォールバック
    const w = dropdownPos ? Math.max(140, Math.floor(dropdownPos.w * 0.5)) : 220;
    const top = dropdownPos ? dropdownPos.y : 200;
    const left = dropdownPos ? dropdownPos.x : 24;

    return (
      <Modal transparent visible animationType="fade">
        <Pressable style={s.overlay} onPress={() => setModalVisible(false)}>
          <View style={[s.dropdown, { top, left, width: w }]}>
            <Pressable style={s.option} onPress={() => handleChange("soniox")}>
              <Text style={s.optionText}>Soniox STT</Text>
            </Pressable>
            <Pressable style={s.option} onPress={() => handleChange("local")}>
              <Text style={s.optionText}>ローカル STT</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    );
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>設定</Text>

        <Text style={s.item}>・音声認識</Text>
        <Pressable ref={selectorRef} style={s.selector} onPress={openDropdown}>
          <Text style={s.selectorText}>
            {sttMode === "local" ? "ローカル STT" : "Soniox STT"}
          </Text>
        </Pressable>

        {renderDropdown()}

        <View style={{ height: 32 }} />
        <Text style={s.title}>バージョン</Text>
        <Text style={s.item}>・ver0.5.3   20251005：STT（音声認識）を選択できるように。</Text>
        <Text style={s.item}>・ver0.4.2   20250907：ボイス追加：Google TTS/Gemini Speech Generation</Text>
        <Text style={s.item}>・ver0.3.0   20250901：マイク機能追加</Text>
        <Text style={s.item}>・ver0.2.0   20250831：会話機能追加。マイクは利用不可</Text>
        <Text style={s.item}>・ver0.1.0   20250830：テストアプリ登録。ホーム/会話/設定画面のみ</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  wrap: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  item: { fontSize: 16, color: "#444" },
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
  selectorText: { fontSize: 16 },
  overlay: { flex: 1 },
  dropdown: {
    position: "absolute",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    elevation: 3,
  },
  option: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  optionText: { fontSize: 16 },
});
