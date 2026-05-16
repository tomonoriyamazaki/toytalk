# CLAUDE.md

## システム構成

子供向け音声AIおもちゃ「ToyTalker」。ユーザーが話しかけると、キャラクターが音声で返答する。

### アーキテクチャ概要

```
[App / ESP32] → STT(Soniox直接WS) → Lambda(LLM+TTS streaming) → 音声再生
                                   → Lambda(相槌: LLM処理中の繋ぎ応答)
```

- **ストリーミング前提設計**: LLM→TTSは直列ストリーミング。最初のチャンクが生成され次第再生開始し、体感レイテンシを最小化
- **STTはLambdaを経由しない**: Soniox一時キーをLambdaが発行し、クライアントがSonioxに直接WebSocket接続（Lambda経由のボトルネック回避）
- **相槌(backchannel)**: メインLLMの処理中に「そうだね〜」等の短い応答を先に返してUXを保つ仕組み
- **App / ESP32は対称構成**: 各々に本Lambda+相槌Lambdaがあり、出力形式だけ異なる（App=base64, ESP32=PCM）

### TTSプロバイダー

複数プロバイダーをプラガブルに切替可能（DynamoDB `toytalker-voices` で管理）:
OpenAI / Google / Gemini / ElevenLabs / FishAudio / Sakura(ずんだもん) / ZakiCorp(自前クローンボイス, β版)

### Lambda一覧

| Lambda | 用途 | ディレクトリ |
|---|---|---|
| `toytalk-stream-handler-lambda` | App用メイン（LLM+TTS streaming） | `backend/toytalk-stream-handler-lambda` |
| `toytalk-api-stream-for-esp32-lambda` | ESP32用メイン（LLM+TTS streaming） | `backend/toytalk-api-stream-for-esp32-lambda` |
| `toytalker-backchannel-for-app-lambda` | App用相槌 | `backend/toytalker-backchannel-for-app-lambda` |
| `toytalker-backchannel-for-esp32-lambda` | ESP32用相槌 | `backend/toytalker-backchannel-for-esp32-lambda` |
| `toytalk-soniox-stt-lambda` | Soniox一時キー発行 | `backend/toytalk-soniox-stt-lambda` |
| `toytalker-device-setting-lambda` | デバイス登録・ボイス設定・コスト管理 | `backend/toytalker-device-setting-lambda` |
| `toytalker-tts-only-lambda` | App用 読み上げ（テキスト→TTSのみ、LLM/STTなし、音声バイナリ直返し） | `backend/toytalker-tts-only-lambda` |

### DynamoDBテーブル一覧

| テーブル | 用途 |
|---|---|
| `toytalker-devices` | ESP32デバイス登録 |
| `toytalker-characters` | キャラクター定義（人格プロンプト） |
| `toytalker-voices` | ボイス設定（プロバイダー・モデル・voice_id） |
| `toytalker-llms` | LLM設定 |
| `toytalker-chat-logs` | 会話履歴・トークン使用量 |
| `toytalker-usage` | API利用量トラッキング |
| `toytalker-api-unit-prices` | 各API単価 |
| `toytalker-exchange-rates` | USD-JPY為替レート |

### デバイス世代

- v1: Raspberry Pi（廃止）
- v2: スマホアプリ経由（現行）
- v3: ESP32-S3スタンドアロン（現行、アプリ不要で直接AWS通信）

## ワークフロールール

- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイする。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。
- PowerShellでgitコマンドを実行するとき、`Set-Location` を使わず `git` から直接実行する（パーミッション設定のパターンマッチが効かなくなるため）。

## ZakiCorp TTS（クローンボイス, β版）

ローカルPC (RTX 5090) でQwen3-TTSベースのクローンボイスAPIサーバーを稼働。ngrokでインターネットに公開し、Lambdaから利用する。

### 起動

ログオン時にタスクスケジューラ (`TTS-AutoStart`) が自動起動。手動起動は不要。
- スクリプト: `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\scripts\start-tts-service.ps1`
- APIサーバー + ngrok起動 → URL変更時はLambda環境変数 (`ZAKICORP_TTS_URL`) を5つ自動更新
- ログ: `scripts\tts-service.log` / トースト通知(BurntToast)

### ngrok URL変更時のLambda更新対象

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)

### S3 / DynamoDB

- S3バケット: `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ保管
- DynamoDBテーブル: `toytalker-voices` — ZakiCorpボイスエントリ (provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name})
