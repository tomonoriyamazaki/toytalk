import { useState, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

export function useOwnerId(): string | null {
  const [ownerId, setOwnerId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      let id = await AsyncStorage.getItem(OWNER_ID_KEY);
      if (!id) {
        id = generateUUID();
        await AsyncStorage.setItem(OWNER_ID_KEY, id);
      }
      setOwnerId(id);
    })();
  }, []);

  return ownerId;
}
