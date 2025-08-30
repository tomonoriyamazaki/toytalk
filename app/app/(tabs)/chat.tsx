import { useState } from "react";
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";

export default function Chat() {
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const send = () => {
    const t = msg.trim();
    if (!t) return;
    setLog((L) => [...L, `You: ${t}`, `ToyTalk: ${t} いいね！`]);
    setMsg("");
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.chat}>{log.map((l, i) => <Text key={i} style={s.line}>{l}</Text>)}</View>
      <View style={s.inputRow}>
        <TextInput value={msg} onChangeText={setMsg} placeholder="メッセージを入力…" style={s.input} />
        <TouchableOpacity style={s.btn} onPress={send}><Text style={s.btnText}>送信</Text></TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  chat: { flex: 1, padding: 16, gap: 8 },
  line: { fontSize: 16 },
  inputRow: { flexDirection: "row", gap: 8, padding: 12, borderTopWidth: 1, borderColor: "#eee" },
  input: { flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  btn: { backgroundColor: "#111", paddingHorizontal: 16, borderRadius: 12, justifyContent: "center" },
  btnText: { color: "#fff", fontWeight: "600" },
});

