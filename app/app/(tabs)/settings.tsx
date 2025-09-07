import { SafeAreaView, Text, View, StyleSheet } from "react-native";

export default function Settings() {
  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>設定</Text>
        <Text style={s.item}>・（ここに項目を追加）</Text>
        <Text style={s.item}></Text>
        <Text style={s.item}></Text>
        <Text style={s.title}>バージョン</Text>
        <Text style={s.item}>・ver0.4.1     20250907：</Text>
        <Text style={s.item}>ボイス：Gemini Speech Generationを追加</Text>
        <Text style={s.item}>・ver0.4.0     20250907：</Text>
        <Text style={s.item}>ボイス：Google TTSを追加。ボイス選択できるように</Text>
        <Text style={s.item}>・ver0.3.0     20250901：</Text>
        <Text style={s.item}>マイク機能追加</Text>
        <Text style={s.item}>・ver0.2.0     20250831：</Text>
        <Text style={s.item}>会話機能追加。マイク不可。文字入力が必要</Text>
        <Text style={s.item}>・ver0.1.0     20250830：</Text>
        <Text style={s.item}>テストアプリ登録。ホーム/会話/設定画面のみ</Text>
        <Text style={s.item}></Text>
      </View>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  wrap: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  item: { fontSize: 16, color: "#444" },
});

