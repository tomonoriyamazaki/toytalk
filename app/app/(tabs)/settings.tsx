import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  Pressable,
  Modal,
  Dimensions,
  findNodeHandle,
  UIManager,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";

export default function Settings() {
  const [sttMode, setSttMode] = useState("local");
  const [modalVisible, setModalVisible] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ x: 0, y: 0, w: 0 });
  const selectorRef = useRef(null);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem("sttMode");
      if (saved) setSttMode(saved);
    })();
  }, []);

  const openDropdown = () => {
    if (selectorRef.current) {
      const handle = findNodeHandle(selectorRef.current);
      UIManager.measure(handle, (x, y, width, height, pageX, pageY) => {
        setDropdownPos({ x: pageX, y: pageY + height, w: width });
        setModalVisible(true);
      });
    }
  };

  const handleChange = async (value: "local" | "soniox") => {
    setSttMode(value);
    await AsyncStorage.setItem("sttMode", value);
    setModalVisible(false);
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>設定</Text>

        <Text style={s.item}>・音声認識</Text>
        <Pressable
          ref={selectorRef}
          style={s.selector}
          onPress={openDropdown}
        >
          <Text style={s.selectorText}>
            {sttMode === "local" ? "ローカル STT" : "Soniox STT"}
          </Text>
        </Pressable>

        {/* ドロップダウン */}
        <Modal transparent visible={modalVisible} animationType="fade">
          <Pressable style={s.overlay} onPress={() => setModalVisible(false)}>
            <View
              style={[
                s.dropdown,
                { top: dropdownPos.y, left: dropdownPos.x, width: dropdownPos.w * 0.5 }, // 幅を半分
              ]}
            >
              <Pressable style={s.option} onPress={() => handleChange("local")}>
                <Text style={s.optionText}>ローカル STT</Text>
              </Pressable>
              <Pressable style={s.option} onPress={() => handleChange("soniox")}>
                <Text style={s.optionText}>Soniox STT</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>

        <View style={{ height: 32 }} /> {/* バージョンまで2行分スペース */}
        <Text style={s.title}>バージョン</Text>
        <Text style={s.item}>・ver0.5.0   20250929：音声認識（STT）設定追加</Text>
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
  width: "50%",          // ← 半分幅
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
