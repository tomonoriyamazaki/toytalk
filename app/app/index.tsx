import { Image, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

export default function Home() {
  const router = useRouter();
  return (
    <SafeAreaView style={s.root}>
      <Pressable style={s.touch} onPress={() => router.replace("/(tabs)/chat")}>
        <View style={s.wrap}>
          <Image source={require("../assets/images/mascot.png")} style={s.logo} resizeMode="contain" />
          <Text style={s.hint}>タップで会話へ</Text>
        </View>
      </Pressable>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  touch: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  wrap: { width: "100%", alignItems: "center", gap: 16 },
  logo: { width: 280, height: 280 },
  hint: { color: "#888", fontSize: 16 },
});

