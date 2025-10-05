// usage.tsx
import { SafeAreaView, View, Button, StyleSheet, Text } from "react-native";
import { useState, useRef } from "react";
import * as FileSystem from "expo-file-system";
import AudioRecord from "react-native-audio-record";
import { Audio, InterruptionModeIOS } from "expo-av";
import Sound from "react-native-sound"; // ← 追加！

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

  // expo-avで再生
  const playRecording = async () => {
    if (!filePath) return;

    await Audio.setIsEnabledAsync(false);
    await Audio.setIsEnabledAsync(true);

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    });

    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }

    const { sound } = await Audio.Sound.createAsync({ uri: filePath });
    soundRef.current = sound;
    await sound.playAsync();
    console.log("🔊 Playing (expo-av):", filePath);
  };

  // react-native-soundで再生
  const playWithSoundLib = async () => {
    if (!filePath) return;

    // Expo環境のAudioSessionをいったん無効化（競合防止）
    await Audio.setIsEnabledAsync(false);

    const path = filePath.replace("file://", ""); // ← Soundはfile://を嫌う場合がある
    Sound.setCategory("Playback");

    const s = new Sound(path, "", (error) => {
      if (error) {
        console.log("❌ Failed to load with Sound:", error);
        return;
      }
      console.log("✅ Loaded with Sound, duration:", s.getDuration());
      s.play((success) => {
        if (success) console.log("✅ Finished playing (Sound)");
        else console.log("⚠️ Playback failed (Sound)");
        s.release();
      });
    });
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>※録音＆再生テスト</Text>
        <Button title="録音開始" onPress={startRecording} />
        <Button title="録音停止" onPress={stopRecording} />
        <Button title="expo-avで再生" onPress={playRecording} disabled={!filePath} />
        <Button title="react-native-soundで再生" onPress={playWithSoundLib} disabled={!filePath} />
        <Button
          title="🔄 Force Playback"
          onPress={async () => {
            await Audio.setAudioModeAsync({
              allowsRecordingIOS: false,
              playsInSilentModeIOS: true,
              staysActiveInBackground: false,
              interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            });
            console.log("🔄 強制Playback切替");
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  wrap: { padding: 20, gap: 12 },
  title: { fontWeight: "bold", marginBottom: 10 },
});
