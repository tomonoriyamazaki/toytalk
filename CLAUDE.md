# CLAUDE.md

## ワークフロールール

- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイする。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。

## ZakiCorp TTS（クローンボイス, β版）

ローカルPC (RTX 5090) でQwen3-TTSベースのクローンボイスAPIサーバーを稼働。ngrokでインターネットに公開し、Lambdaから利用する。

### 起動手順（PC再起動後など）

1. **APIサーバー起動** — ターミナルで:
   ```
   cd C:\Users\exodj\projects\tts-models\faster-qwen3-tts
   set ZAKICORP_API_KEY=<メモリ参照>
   python api_server.py
   ```
   ポート8000、モデルウォームアップ約8-9秒、speaker_*.ptを自動ロード

2. **ngrokトンネル起動** — 別ターミナルで:
   ```
   ngrok http 8000
   ```
   無料プランのためURLは再起動で変わる

### ngrok URL変更時のLambda環境変数更新対象

`ZAKICORP_TTS_URL` を新しいngrok URLに更新する:

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-device-setting-lambda` (ボイス登録) ※追加予定

### S3 / DynamoDB

- S3バケット: `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ保管
- DynamoDBテーブル: `toytalker-voices` — ZakiCorpボイスエントリ (provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name})
