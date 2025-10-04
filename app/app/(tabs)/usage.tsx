// usage.tsx
import { SafeAreaView, Text, View, StyleSheet, Button } from "react-native";
import { useEffect, useRef, useState } from "react";
import * as FileSystem from "expo-file-system";
import AudioRecord from "react-native-audio-record";
import { Audio } from "expo-av";

export default function Usage() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const silentRef = useRef<Audio.Sound | null>(null);

  // 16kHz/16bit/mono/約120msの無音WAV（ちゃんと再生できる最小構成）
  // 必要なら長さは後で差し替えOK
  const SILENCE_WAV_BASE64 =
    "UklGRgAAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const normalizeUri = (p: string) => (p.startsWith("file://") ? p : "file://" + p);

  // 無音をプリロード（毎回create/unloadせずreplayで即走らせる）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const path = FileSystem.cacheDirectory + "silence.wav";
        await FileSystem.writeAsStringAsync(path, SILENCE_WAV_BASE64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const { sound } = await Audio.Sound.createAsync({ uri: path });
        if (mounted) silentRef.current = sound;
      } catch (e) {
        console.error("silent preload error:", e);
      }
    })();
    return () => {
      mounted = false;
      silentRef.current?.unloadAsync();
      soundRef.current?.unloadAsync();
    };
  }, []);

  // 録音初期化
  useEffect(() => {
    AudioRecord.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      wavFile: "test.wav",
    });
  }, []);

  // iOSを確実にPlaybackへ戻す + 無音を一発流してセッションを切替
  const forcePlayback = async () => {
    // まれにAVAudioSessionが固まるのでリセット→モード設定→無音再生の順で叩く
    await Audio.setIsEnabledAsync(false);
    await wait(10);
    await Audio.setIsEnabledAsync(true);
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });
    await wait(20);
    if (silentRef.current) {
      await silentRef.current.replayAsync(); // createAsync不要で速い
      // すぐ止めなくてOK（約120ms）。止めたいなら:
      // await silentRef.current.stopAsync();
    }
  };

  const startRecording = () => {
    setFilePath(null);
    AudioRecord.start();
    console.log("🎙️ Recording started");
  };

  const stopRecording = async () => {
    const raw = await AudioRecord.stop();
    console.log("🛑 Recording stopped, raw path:", raw);
    if (!raw) return;

    const uri = normalizeUri(raw);

    // 書き出し完了待ち（サイズ>0になるまでポーリング）
    for (let i = 0; i < 6; i++) {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && (info.size ?? 0) > 0) break;
      await wait(40);
    }

    setFilePath(uri);

    try {
      await forcePlayback();
      console.log("✅ Forced Playback mode");

      // ★停止＝即再生したい場合はここをtrueに
      const AUTO_PLAY_AFTER_STOP = true;
      if (AUTO_PLAY_AFTER_STOP) {
        await playRecordingInternal(uri);
      }
    } catch (e) {
      console.error("forcePlayback error:", e);
    }
  };

  const playRecordingInternal = async (uri: string) => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;
      await sound.playAsync();
      console.log("🔊 Playing:", uri);
    } catch (e) {
      console.error("playRecording error:", e);
    }
  };

  const playRecording = async () => {
    if (!filePath) return;
    // 念のため毎回Playbackに寄せてから再生
    await forcePlayback();
    await playRecordingInternal(filePath);
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>利用状況</Text>
        <Text style={s.item}>・（ここに項目を追加）</Text>

        <View style={s.section}>
          <Text style={s.subtitle}>🎤 音声検証</Text>
          <Button title="録音開始" onPress={startRecording} />
          <Button title="録音停止（停止後に自動でPlayback化＆再生）" onPress={stopRecording} />
          <Button title="手動再生" onPress={playRecording} disabled={!filePath} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  wrap: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  item: { fontSize: 16, color: "#444" },
  section: { marginTop: 30, gap: 8 },
  subtitle: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
});
