// usage.tsx
import { SafeAreaView, View, Button, StyleSheet } from "react-native";
import { useState, useRef } from "react";
import * as FileSystem from "expo-file-system";
import AudioRecord from "react-native-audio-record";
import { Audio } from "expo-av";

export default function Usage() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // 録音初期化（初回のみ）
  const initRecording = () => {
    AudioRecord.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      wavFile: "test.wav",
    });
  };

  // 録音開始
  const startRecording = () => {
    setFilePath(null);
    initRecording();
    AudioRecord.start();
    console.log("🎙️ Recording started");
  };

  // 録音停止
  const stopRecording = async () => {
    const raw = await AudioRecord.stop();
    console.log("🛑 Recording stopped, raw path:", raw);
    if (!raw) return;
    const uri = raw.startsWith("file://") ? raw : "file://" + raw;

    // 書き出し完了待ち
    let info = { exists: false, size: 0 };
    for (let i = 0; i < 5; i++) {
      info = await FileSystem.getInfoAsync(uri);
      if (info.exists && (info.size ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    setFilePath(uri);
    console.log("✅ File ready:", uri);
  };

  // 再生
  const playRecording = async () => {
    if (!filePath) return;

    // Playbackモードへ切替
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

    // 古い音声を解放
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }

    // 新しい音声を再生
    const { sound } = await Audio.Sound.createAsync({ uri: filePath });
    soundRef.current = sound;
    await sound.playAsync();
    console.log("🔊 Playing:", filePath);
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Button title="録音開始" onPress={startRecording} />
        <Button title="録音停止" onPress={stopRecording} />
        <Button title="再生" onPress={playRecording} disabled={!filePath} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  wrap: { padding: 20, gap: 12 },
});
