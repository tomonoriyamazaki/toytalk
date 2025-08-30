# ToyTalk Mobile App

ToyTalk の React Native / Expo プロジェクトです。  
iOS / Android アプリのソースコードをこのディレクトリで管理しています。

---

## ��� 開発環境セットアップ

```bash
# 依存パッケージをインストール
npm install

# 開発サーバー起動
npx expo start
````

* iPhone の場合: Expo Go アプリで QR コードを読み取ると動作確認可能
* Android の場合: Expo Go アプリでも同様に確認可能

---

## ��� 環境変数

`.env` ファイルを `app/` 直下に配置して利用します。
APIキーや秘密情報は **必ず Git に含めない** でください。

例:

```env
EXPO_PUBLIC_API_URL=https://api.toytalk.com
OPENAI_API_KEY=sk-xxxx
```

> 本番環境では EAS Secrets に登録してください。

---

## ��� ビルド & デプロイ

### iOS

```bash
npx eas build -p ios --profile production
npx eas submit -p ios --latest
```

* `bundleIdentifier` は `com.zakicorp.toytalk`
* App Store Connect に作成済みのアプリと一致させること

### Android

（未設定）

---

## ��� 開発ルール

* コミット前に `git status` で差分確認
* `node_modules/` や `.env` は `.gitignore` で除外済み
* 大きな変更はブランチを切って作業（例: `feature/chat-ui`）

---

## ✅ TODO

* アイコン、スプラッシュスクリーンの追加
* TestFlight 内部テストでの確認
* 権限まわり（マイク、通知）の実装

```

