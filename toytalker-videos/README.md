# toytalker-videos

ToyTalker TIB FAB 展示用の説明動画シリーズ(Remotion / React + TypeScript)。
制作指示書は `reference/README_toytalker_videos.md`、応答速度本編のタイミングの正は `reference/render.py`(PILプロトタイプ)。

トーンは親子向けの明るいクリーム背景(2026-08-03改訂)。全体構成:

| # | セクション | 尺 | 担当 |
|---|----------|----|------|
| 1 | 会話 | 30 | 実写撮影 |
| 2 | コンセプト | 22 | 本プロジェクト(ペンダント装着→子供の会話→親の振り返り、B/C/締めホールドあり) |
| 3 | 応答速度 | 44.5 | 本プロジェクト(3ステップ説明13.5秒 + パイプライン本編3.6倍スロー) |
| 4 | 声変え | 26 | 本プロジェクト(アプリでキャラ作成→おもちゃに反映、クローンボイス、まとめ以外2倍スロー) |
| 5 | 製作 | 30 | スライド+3Dプリンタ動画 |
| 6 | 操作 | 25 | 操作画面撮影 |

## 使い方

```bash
npm install

# プレビュー(ブラウザでStudioが開く)
npm run studio

# mp4出力(1920x1080 / 30fps / H.264 crf18 / faststart)
npm run render:concept          # → out/toytalker_concept.mp4
npm run render:response-speed   # → out/toytalker_response_speed.mp4
npm run render:voice-change     # → out/toytalker_voice_change.mp4
npm run render:all              # 3本まとめて
```

## 構成

| パス | 内容 |
|---|---|
| `src/theme.ts` | カラー・サイズ・字幕スタイルのトークン。ブランドカラー確定時はここだけ差し替える |
| `src/fonts.ts` | Noto Sans JP(Google Fonts)のロード |
| `src/components/Subtitle.tsx` | 共通字幕。切り替え時0.3秒クロスフェード。サイズは `CAPTION.fontSize`(48、最大56まで想定) |
| `src/components/StageCard.tsx` | パイプライン段カード(STT/LLM/TTS/デバイス) |
| `src/components/Pill.tsx` | チャンクピル(テキスト/音声/再生中の3状態、再生中は波形バー内蔵) |
| `src/components/Waveform.tsx` | 波形バーアニメ(サイズ可変) |
| `src/components/Pendant.tsx` | ペンダント型デバイス(4cm)のイラスト表現 |
| `src/components/PhoneFrame.tsx` | アプリ画面のスマホフレーム |
| `src/videos/Concept.tsx` | 動画2「コンセプト」(22秒、装着→会話→振り返り→締め) |
| `src/videos/ResponseSpeed.tsx` | 動画3「応答速度」(44.5秒、3ステップ説明+パイプライン本編3.6倍スロー) |
| `src/videos/VoiceChange.tsx` | 動画4「声変え」(26秒、アプリ設定→反映、キャラ音声→クローン) |
| `src/Root.tsx` | 合成定義。尺・fps・解像度はここで一元管理 |

## デバイス実機写真のはめ込み

1. 写真を `public/` に置く(例: `public/toytalker_mini.png`)
2. `src/theme.ts` の `DEVICE_PHOTO` にファイル名を設定:
   ```ts
   export const DEVICE_PHOTO: string | null = 'toytalker_mini.png';
   ```
3. 応答速度のデバイスカード右側と、コンセプトの中央ビジュアル(🧸プレースホルダーと差し替え)に自動反映される

## 今後

- 実機写真の支給待ち(`DEVICE_PHOTO` 設定のみで反映)
- 実写パート(1, 5, 6)は DaVinci Resolve 編集。字幕スタイルは `theme.ts` のトークンを参照して合わせる
