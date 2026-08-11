import { useState, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// owner_id はキーチェーン(SecureStore)を正として保持する。
// キーチェーンはアプリを削除しても端末に残るため、dev⇔TestFlightの入れ替えや
// 再インストールでもIDが変わらない(iOS)。AsyncStorageは旧バージョンからの移行元。
const OWNER_ID_KEY = "owner_id";

function generateUUID(): string {
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += "-";
    } else if (i === 14) {
      uuid += "4";
    } else {
      uuid += hex[Math.floor(Math.random() * 16)];
    }
  }
  return `u_${uuid}`;
}

async function resolveOwnerId(): Promise<string> {
  // ① キーチェーン(端末に永続)
  try {
    const fromKeychain = await SecureStore.getItemAsync(OWNER_ID_KEY);
    if (fromKeychain) return fromKeychain;
  } catch {
    // SecureStore不能な環境(一部Android等)はAsyncStorageのみで動かす
  }

  // ② AsyncStorage(旧バージョンの保存先) → あればキーチェーンへ移行
  const fromAsync = await AsyncStorage.getItem(OWNER_ID_KEY);
  const id = fromAsync ?? generateUUID();

  try {
    await SecureStore.setItemAsync(OWNER_ID_KEY, id, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch {
    // キーチェーンに書けなくてもAsyncStorageで従来通り動作
  }
  if (!fromAsync) {
    await AsyncStorage.setItem(OWNER_ID_KEY, id);
  }
  return id;
}

export function useOwnerId(): string | null {
  const [ownerId, setOwnerId] = useState<string | null>(null);

  useEffect(() => {
    resolveOwnerId().then(setOwnerId);
  }, []);

  return ownerId;
}
