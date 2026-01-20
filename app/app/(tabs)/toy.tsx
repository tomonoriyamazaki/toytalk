import { useState, useEffect } from "react";
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
} from "react-native";
import { BleManager, Device } from "react-native-ble-plx";

// BLE UUIDs (ESP32側と一致させる)
const SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";
const CHAR_SSID_UUID = "12345678-1234-1234-1234-123456789ab1";
const CHAR_PASSWORD_UUID = "12345678-1234-1234-1234-123456789ab2";
const CHAR_COMMAND_UUID = "12345678-1234-1234-1234-123456789ab3";
const CHAR_STATUS_UUID = "12345678-1234-1234-1234-123456789ab4";

const bleManager = new BleManager();

type ConnectionStatus = "disconnected" | "scanning" | "connecting" | "connected" | "configuring";

export default function Toy() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    // Androidの権限リクエスト
    if (Platform.OS === "android") {
      requestAndroidPermissions();
    }

    return () => {
      // クリーンアップ
      bleManager.stopDeviceScan();
    };
  }, []);

  const requestAndroidPermissions = async () => {
    if (Platform.OS === "android" && Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      console.log("Permissions:", granted);
    } else if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      console.log("Location permission:", granted);
    }
  };

  const startScan = () => {
    setDevices([]);
    setStatus("scanning");
    setStatusMessage("スキャン中...");

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error("Scan error:", error);
        setStatus("disconnected");
        setStatusMessage("スキャンエラー: " + error.message);
        return;
      }

      if (device && device.name) {
        // ToyTalk-Setupデバイスのみ表示
        if (device.name.includes("ToyTalk")) {
          setDevices((prev) => {
            if (prev.find((d) => d.id === device.id)) return prev;
            return [...prev, device];
          });
        }
      }
    });

    // 10秒後にスキャン停止
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

      setConnectedDevice(connected);
      setStatus("connected");
      setStatusMessage("接続完了！WiFi設定を入力してください");

      // 状態通知を購読
      connected.monitorCharacteristicForService(
        SERVICE_UUID,
        CHAR_STATUS_UUID,
        (error, characteristic) => {
          if (error) {
            console.error("Monitor error:", error);
            return;
          }
          if (characteristic?.value) {
            const decoded = atob(characteristic.value);
            console.log("Status from ESP32:", decoded);
            handleStatusUpdate(decoded);
          }
        }
      );

      // 切断検知
      connected.onDisconnected(() => {
        setConnectedDevice(null);
        setStatus("disconnected");
        setStatusMessage("切断されました");
      });
    } catch (error: any) {
      console.error("Connection error:", error);
      setStatus("disconnected");
      setStatusMessage("接続エラー: " + error.message);
    }
  };

  const handleStatusUpdate = (status: string) => {
    switch (status) {
      case "CONNECTING":
        setStatusMessage("WiFi接続中...");
        break;
      case "CONNECTED":
        setStatusMessage("✅ WiFi接続成功！");
        Alert.alert("成功", "WiFi設定が完了しました");
        break;
      case "FAILED":
        setStatusMessage("❌ WiFi接続失敗");
        Alert.alert("エラー", "WiFi接続に失敗しました。SSID/パスワードを確認してください。");
        break;
      default:
        setStatusMessage(status);
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

      // SSIDを送信
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_SSID_UUID,
        btoa(ssid)
      );

      // パスワードを送信
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_PASSWORD_UUID,
        btoa(password)
      );

      // 接続コマンドを送信
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_COMMAND_UUID,
        btoa("CONNECT")
      );

      setStatusMessage("設定送信完了、WiFi接続を待機中...");
    } catch (error: any) {
      console.error("Write error:", error);
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
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.wrap}>
        <Text style={s.title}>おもちゃ設定</Text>

        {/* ステータス表示 */}
        {statusMessage ? (
          <View style={s.statusBox}>
            <Text style={s.statusText}>{statusMessage}</Text>
          </View>
        ) : null}

        {/* 未接続時: スキャン */}
        {status === "disconnected" && (
          <>
            <TouchableOpacity style={s.button} onPress={startScan}>
              <Text style={s.buttonText}>🔍 デバイスをスキャン</Text>
            </TouchableOpacity>

            {devices.length > 0 && (
              <View style={s.deviceList}>
                <Text style={s.subtitle}>見つかったデバイス:</Text>
                <FlatList
                  data={devices}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={s.deviceItem}
                      onPress={() => connectToDevice(item)}
                    >
                      <Text style={s.deviceName}>{item.name}</Text>
                      <Text style={s.deviceId}>{item.id}</Text>
                    </TouchableOpacity>
                  )}
                />
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

        {/* 接続済み: WiFi設定フォーム */}
        {(status === "connected" || status === "configuring") && (
          <View style={s.form}>
            <Text style={s.subtitle}>WiFi設定</Text>

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
                <Text style={s.buttonText}>📶 WiFi設定を送信</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={s.buttonSecondary} onPress={disconnect}>
              <Text style={s.buttonTextSecondary}>切断</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f5f5" },
  wrap: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
  statusBox: {
    backgroundColor: "#e3f2fd",
    padding: 12,
    borderRadius: 8,
  },
  statusText: { fontSize: 14, color: "#1976d2" },
  button: {
    backgroundColor: "#007AFF",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#999",
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  buttonSecondary: {
    backgroundColor: "#fff",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  buttonTextSecondary: { color: "#666", fontSize: 16 },
  deviceList: { marginTop: 16 },
  deviceItem: {
    backgroundColor: "#fff",
    padding: 16,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
  },
  deviceName: { fontSize: 16, fontWeight: "600" },
  deviceId: { fontSize: 12, color: "#888", marginTop: 4 },
  center: { alignItems: "center", gap: 16, marginTop: 20 },
  loadingText: { fontSize: 16, color: "#666" },
  form: { gap: 12 },
  label: { fontSize: 14, fontWeight: "500", color: "#333" },
  input: {
    backgroundColor: "#fff",
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    fontSize: 16,
  },
});
