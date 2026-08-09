// ToyTalker 展示動画シリーズ — デザイントークン
// 親子向けの明るいトーン。ブランドカラー確定時はここを差し替えるだけで全動画に反映される

export const COLORS = {
  bg: '#FDF6EC', // あたたかいクリーム
  card: '#FFFFFF',
  cardActive: '#F3EFFF', // やわらかいラベンダー
  border: '#E8E0D3',
  accent: '#7C6FE0', // アクティブ枠・カーソル
  text: '#33395C', // ダークネイビー
  textSub: '#8A8FA8',
  coral: '#FF8A5C', // 子供・あたたかさの強調
  // ピル: テキストチャンク
  pillText: {fill: '#EDEAFF', text: '#4A3FB5', border: '#B9B0F0'},
  // ピル: 音声チャンク(待機)
  pillAudio: {fill: '#E0F6EE', text: '#0F7A5A', border: '#63CCA8'},
  // ピル: 再生中
  pillPlaying: {fill: '#22B583', text: '#FFFFFF', border: '#22B583'},
  teal: '#12A47C', // 大見出し(明るい背景でも読める濃いめのティール)
} as const;

// まとめ画面などの全画面オーバーレイ(背景色ベースの半透明)
export const OVERLAY_RGB = '253, 246, 236';
export const OVERLAY_ALPHA = 0.88;

// サイズ(1080p 基準, px)
export const SIZES = {
  title: 46,
  stage: 40,
  body: 38,
  pill: 34,
  lane: 30,
  note: 28,
  bigHead: 72,
  midLine: 40,
} as const;

// 字幕キャプション。展示で読みにくければ 56 まで上げる
export const CAPTION = {
  fontSize: 48,
  paddingX: 40,
  bg: '#FFFFFF',
  bgOpacity: 0.94,
  radius: 16,
  crossfadeSec: 0.3,
} as const;

// デバイスカードにはめ込む実機写真。public/ に置いてファイル名を指定する
// 例: export const DEVICE_PHOTO: string | null = 'toytalker_mini.png';
export const DEVICE_PHOTO: string | null = null;

export const FONT_FAMILY = `'Noto Sans JP', 'Noto Sans CJK JP', sans-serif`;
