import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
  ScrollView,
} from "react-native";
import { BleManager, Device } from "react-native-ble-plx";

// BLE UUIDs (ESP32側と一致させる)
const SERVICE_UUID       = "12345678-1234-1234-1234-123456789abc";
const CHAR_SSID_UUID     = "12345678-1234-1234-1234-123456789ab1";
const CHAR_PASSWORD_UUID = "12345678-1234-1234-1234-123456789ab2";
const CHAR_COMMAND_UUID  = "12345678-1234-1234-1234-123456789ab3";
const CHAR_STATUS_UUID   = "12345678-1234-1234-1234-123456789ab4";
const CHAR_MAC_UUID      = "12345678-1234-1234-1234-123456789ab5";

const DEVICE_SETTING_URL   = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";
const DEFAULT_CHARACTER_ID = "default";

const bleManager = new BleManager();

type ConnectionStatus = "disconnected" | "scanning" | "connecting" | "connected" | "configuring";
type Screen = "home" | "wifi-setup" | "device-settings" | "character-select";

type CharacterItem = {
  character_id: string;
  name: string;
  description: string;
  owner_id: string;
  voice_id: string;
  personality_prompt?: string;
};

type RegisteredDevice = {
  device_id: string;
  character_id: string | null;
  owner_id: string;
};

export default function Toy() {
  const [status, setStatus]                         = useState<ConnectionStatus>("disconnected");
  const [bleDevices, setBleDevices]                 = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice]       = useState<Device | null>(null);
  const [ssid, setSsid]                             = useState("");
  const [password, setPassword]                     = useState("");
  const [statusMessage, setStatusMessage]           = useState("");
  const [screen, setScreen]                         = useState<Screen>("home");
  const [deviceId, setDeviceId]                     = useState<string | null>(null);
  const [registeredDevice, setRegisteredDevice]     = useState<RegisteredDevice | null>(null);
  const [characters, setCharacters]                 = useState<CharacterItem[]>([]);
  const [charactersLoading, setCharactersLoading]   = useState(false);
  const [updatingCharacter, setUpdatingCharacter]   = useState(false);

  useEffect(() => {
    if (Platform.OS === "android") {
      requestAndroidPermissions();
    }
    // AsyncStorageから登録済みデバイスを復元
    AsyncStorage.getItem("registeredDevice").then((val) => {
      if (val) {
        const d = JSON.parse(val);
        setRegisteredDevice(d);
        setDeviceId(d.device_id);
      }
    });
    return () => {
      bleManager.stopDeviceScan();
    };
  }, []);

  const requestAndroidPermissions = async () => {
    if (Platform.OS === "android" && Platform.Version >= 31) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
    } else if (Platform.OS === "android") {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    }
  };

  const startScan = () => {
    setBleDevices([]);
    setStatus("scanning");
    setStatusMessage("スキャン中...");

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        setStatus("disconnected");
        setStatusMessage("スキャンエラー: " + error.message);
        return;
      }
      if (device?.name?.includes("ToyTalk")) {
        setBleDevices((prev) => {
          if (prev.find((d) => d.id === device.id)) return prev;
          return [...prev, device];
        });
      }
    });

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setStatus("disconnected");
      setStatusMessage("スキャン完了");
    }, 10000);
  };

  const stopScan = () => {
    bleManager.stopDeviceScan();
    setStatus("disconnected");
    setStatusMessage("");
  };

  const connectToDevice = async (device: Device) => {
    try {
      bleManager.stopDeviceScan();
      setStatus("connecting");
      setStatusMessage("接続中...");

      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      // MACアドレスをCHAR_MACから読み取る
      const macChar = await connected.readCharacteristicForService(SERVICE_UUID, CHAR_MAC_UUID);
      const mac = macChar.value ? atob(macChar.value) : device.id;
      setDeviceId(mac);

      setConnectedDevice(connected);
      setStatus("connected");
      setStatusMessage("接続完了！WiFi設定を入力してください");
      setScreen("wifi-setup");

      connected.monitorCharacteristicForService(
        SERVICE_UUID,
        CHAR_STATUS_UUID,
        (error, characteristic) => {
          if (error) return;
          if (characteristic?.value) {
            handleStatusUpdate(atob(characteristic.value), mac);
          }
        }
      );

      connected.onDisconnected(() => {
        setConnectedDevice(null);
        setStatus("disconnected");
        setStatusMessage("");
        setScreen("home");
      });
    } catch (error: any) {
      setStatus("disconnected");
      setStatusMessage("接続エラー: " + error.message);
    }
  };

  const handleStatusUpdate = async (bleStatus: string, mac: string) => {
    switch (bleStatus) {
      case "CONNECTING":
        setStatusMessage("WiFi接続中...");
        break;
      case "CONNECTED":
        setStatusMessage("WiFi接続成功！デバイスを登録中...");
        await registerDevice(mac);
        break;
      case "FAILED":
        setStatusMessage("WiFi接続失敗");
        Alert.alert("エラー", "WiFi接続に失敗しました。SSID/パスワードを確認してください。");
        break;
      default:
        setStatusMessage(bleStatus);
    }
  };

  const registerDevice = async (mac: string) => {
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: mac }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // 登録後にデバイス情報を取得
      const deviceRes = await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(mac)}`);
      const deviceData = await deviceRes.json();
      setRegisteredDevice(deviceData);
      await AsyncStorage.setItem("registeredDevice", JSON.stringify(deviceData));
      setStatusMessage("デバイス登録完了！");
    } catch (e: any) {
      setStatusMessage("デバイス登録エラー: " + e.message);
    }
  };

  const sendWiFiConfig = async () => {
    if (!connectedDevice) {
      Alert.alert("エラー", "デバイスに接続されていません");
      return;
    }
    if (!ssid) {
      Alert.alert("エラー", "SSIDを入力してください");
      return;
    }
    try {
      setStatus("configuring");
      setStatusMessage("設定を送信中...");
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_SSID_UUID, btoa(ssid));
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_PASSWORD_UUID, btoa(password));
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_COMMAND_UUID, btoa("CONNECT"));
      setStatusMessage("設定送信完了、WiFi接続を待機中...");
    } catch (error: any) {
      // BLE切断エラーはCONNECTコマンド処理後の正常切断の可能性があるので無視
      if (error.message?.toLowerCase().includes("disconnect")) return;
      setStatus("connected");
      setStatusMessage("送信エラー: " + error.message);
    }
  };

  const disconnect = async () => {
    if (connectedDevice) {
      await connectedDevice.cancelConnection();
      setConnectedDevice(null);
    }
    setStatus("disconnected");
    setStatusMessage("");
    setSsid("");
    setPassword("");
    setScreen("home");
    // registeredDevice と deviceId はAsyncStorageに保持（画面に残す）
  };

  const openDeviceSettings = () => {
    setScreen("device-settings");
  };

  const openCharacterSelect = async () => {
    setCharactersLoading(true);
    setScreen("character-select");
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/characters`);
      const data = await res.json();
      setCharacters(data.characters ?? []);
    } catch (e: any) {
      Alert.alert("エラー", "キャラクター一覧の取得に失敗しました");
    } finally {
      setCharactersLoading(false);
    }
  };

  const selectCharacter = async (characterId: string) => {
    if (!deviceId) return;
    setUpdatingCharacter(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(deviceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_id: characterId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRegisteredDevice((prev) => {
        const updated = prev ? { ...prev, character_id: characterId } : prev;
        if (updated) AsyncStorage.setItem("registeredDevice", JSON.stringify(updated));
        return updated;
      });
      setScreen("device-settings");
    } catch (e: any) {
      Alert.alert("エラー", "キャラクターの更新に失敗しました");
    } finally {
      setUpdatingCharacter(false);
    }
  };

  const currentCharacterLabel = () => {
    if (!registeredDevice?.character_id || registeredDevice.character_id === "default") return "デフォルト";
    const c = characters.find((c) => c.character_id === registeredDevice.character_id);
    return c ? c.name : registeredDevice.character_id;
  };

  // ---- キャラクター選択画面 ----
  if (screen === "character-select") {
    const currentId = registeredDevice?.character_id ?? DEFAULT_CHARACTER_ID;
    const systemChars = characters.filter((c) => c.owner_id === "system");
    const userChars   = characters.filter((c) => c.owner_id !== "system");

    const sections = [
      { title: "システム", data: systemChars },
      { title: "カスタム", data: userChars },
    ].filter((s) => s.data.length > 0);

    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("device-settings")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター選択</Text>
        </View>
        {charactersLoading || updatingCharacter ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : (
          <FlatList
            data={characters}
            keyExtractor={(item) => item.character_id}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            ListHeaderComponent={
              <>
                {sections.map((section) => (
                  <View key={section.title}>
                    <Text style={s.sectionHeader}>{section.title}</Text>
                    {section.data.map((item) => {
                      const selected = item.character_id === currentId;
                      return (
                        <TouchableOpacity
                          key={item.character_id}
                          style={[s.characterItem, selected && s.characterItemSelected]}
                          onPress={() => selectCharacter(item.character_id)}
                        >
                          <View style={s.characterRow}>
                            <View style={[s.radio, selected && s.radioSelected]} />
                            <View style={{ flex: 1 }}>
                              <Text style={[s.characterLabel, selected && s.characterLabelSelected]}>{item.name}</Text>
                              {item.description ? (
                                <Text style={s.characterDesc}>{item.description}</Text>
                              ) : null}
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </>
            }
            renderItem={() => null}
          />
        )}
      </SafeAreaView>
    );
  }

  // ---- デバイス設定画面 ----
  if (screen === "device-settings") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>デバイス設定</Text>
        </View>
        <View style={s.wrap}>
          <Text style={s.deviceIdText}>{deviceId}</Text>
          <TouchableOpacity style={s.settingRow} onPress={openCharacterSelect}>
            <View>
              <Text style={s.settingLabel}>キャラクター</Text>
              <Text style={s.settingValue}>{currentCharacterLabel()}</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---- WiFi設定画面 ----
  if (screen === "wifi-setup") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={disconnect}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>WiFi設定</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          {statusMessage ? (
            <View style={s.statusBox}>
              <Text style={s.statusText}>{statusMessage}</Text>
            </View>
          ) : null}

          {status === "connecting" && (
            <View style={s.center}>
              <ActivityIndicator size="large" color="#007AFF" />
              <Text style={s.loadingText}>接続中...</Text>
            </View>
          )}

          {(status === "connected" || status === "configuring") && (
            <View style={s.form}>
              <Text style={s.label}>SSID (WiFi名)</Text>
              <TextInput
                style={s.input}
                value={ssid}
                onChangeText={setSsid}
                placeholder="WiFiのSSIDを入力"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={s.label}>パスワード</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder="WiFiのパスワードを入力"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[s.button, status === "configuring" && s.buttonDisabled]}
                onPress={sendWiFiConfig}
                disabled={status === "configuring"}
              >
                {status === "configuring" ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={s.buttonText}>WiFi設定を送信</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- ホーム画面 ----
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.wrap}>
        <Text style={s.title}>おもちゃ設定</Text>

        {statusMessage ? (
          <View style={s.statusBox}>
            <Text style={s.statusText}>{statusMessage}</Text>
          </View>
        ) : null}

        {/* 未接続時: スキャン */}
        {status === "disconnected" && (
          <>
            <TouchableOpacity style={s.button} onPress={startScan}>
              <Text style={s.buttonText}>デバイスをスキャン</Text>
            </TouchableOpacity>

            {bleDevices.length > 0 && (
              <View style={s.section}>
                <Text style={s.subtitle}>見つかったデバイス</Text>
                {bleDevices.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={s.deviceItem}
                    onPress={() => connectToDevice(item)}
                  >
                    <View>
                      <Text style={s.deviceName}>{item.name}</Text>
                      <Text style={s.deviceSub}>{item.id}</Text>
                    </View>
                    <Text style={s.chevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}

        {/* スキャン中 */}
        {status === "scanning" && (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
            <TouchableOpacity style={s.buttonSecondary} onPress={stopScan}>
              <Text style={s.buttonTextSecondary}>スキャン停止</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 接続中 */}
        {status === "connecting" && (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={s.loadingText}>接続中...</Text>
          </View>
        )}

        {/* 登録済みデバイス（常に最下部に表示） */}
        {registeredDevice && (
          <View style={s.section}>
            <Text style={s.subtitle}>登録済みデバイス</Text>
            <TouchableOpacity style={s.deviceItem} onPress={openDeviceSettings}>
              <View>
                <Text style={s.deviceName}>{registeredDevice.device_id}</Text>
                <Text style={s.deviceSub}>
                  キャラクター: {registeredDevice.character_id ?? "未設定"}
                </Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:                  { flex: 1, backgroundColor: "#f5f5f5" },
  wrap:                  { padding: 20, gap: 16 },
  title:                 { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  subtitle:              { fontSize: 16, fontWeight: "600", marginBottom: 8, color: "#333" },
  section:               { gap: 8 },
  statusBox:             { backgroundColor: "#e3f2fd", padding: 12, borderRadius: 8 },
  statusText:            { fontSize: 14, color: "#1976d2" },
  button:                { backgroundColor: "#007AFF", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonDisabled:        { backgroundColor: "#999" },
  buttonText:            { color: "#fff", fontSize: 16, fontWeight: "600" },
  buttonSecondary:       { backgroundColor: "#fff", padding: 14, borderRadius: 12, alignItems: "center", borderWidth: 1, borderColor: "#ddd" },
  buttonTextSecondary:   { color: "#666", fontSize: 16 },
  deviceItem:            { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  deviceName:            { fontSize: 15, fontWeight: "600" },
  deviceSub:             { fontSize: 12, color: "#888", marginTop: 2 },
  center:                { alignItems: "center", gap: 16, marginTop: 20 },
  loadingText:           { fontSize: 16, color: "#666" },
  form:                  { gap: 12 },
  label:                 { fontSize: 14, fontWeight: "500", color: "#333" },
  input:                 { backgroundColor: "#fff", padding: 14, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", fontSize: 16 },
  chevron:               { fontSize: 20, color: "#999" },
  // ヘッダー
  header:                { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  headerTitle:           { fontSize: 18, fontWeight: "600" },
  back:                  { fontSize: 16, color: "#007AFF" },
  deviceIdText:          { fontSize: 12, color: "#999", marginBottom: 4 },
  // デバイス設定画面
  settingRow:            { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  settingLabel:          { fontSize: 15, fontWeight: "600" },
  settingValue:          { fontSize: 13, color: "#666", marginTop: 2 },
  // キャラクター選択画面
  characterItem:         { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", marginBottom: 8 },
  characterItemSelected: { borderColor: "#007AFF", backgroundColor: "#f0f7ff" },
  characterRow:          { flexDirection: "row", alignItems: "center", gap: 12 },
  radio:                 { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#ccc" },
  radioSelected:         { borderColor: "#007AFF", backgroundColor: "#007AFF" },
  characterLabel:        { fontSize: 15, fontWeight: "500" },
  characterLabelSelected:{ color: "#007AFF", fontWeight: "600" },
  characterDesc:         { fontSize: 12, color: "#888", marginTop: 2 },
  sectionHeader:         { fontSize: 13, fontWeight: "700", color: "#555", marginTop: 12, marginBottom: 6, textTransform: "uppercase" },
});
