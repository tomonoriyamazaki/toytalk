import { SafeAreaView, Text, View, StyleSheet } from "react-native";

export default function toy() {
  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>おもちゃ</Text>
        <Text style={s.item}>・（ここに項目を追加）</Text>
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

