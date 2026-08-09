import {loadFont} from '@remotion/google-fonts/NotoSansJP';

// CJK フォントは番号付きスライス配信のため subsets は指定しない
// (unicode-range により実際に使う文字のスライスだけダウンロードされる)
const {fontFamily} = loadFont('normal', {
  weights: ['400', '700'],
});

export const FONT = fontFamily;
