import React from 'react';
import {AbsoluteFill} from 'remotion';

// DaVinci用の透過吹き出し素材(実写の操作動画のテロップ用)
// 動画シリーズの Bubble と同じ描き味を大判1枚で書き出す。テキストはDaVinci側で載せる
// 書き出し例:
//   npx remotion still BubbleAsset out/bubbles/bubble_coral.png --props='{"color":"#FF8A5C","tail":true}'
// 縦に広い左しっぽ吹き出し(out/bubble_teal_left.png の形を参考、長文テロップ用)
// しっぽは輪郭と一体化した切り欠きスタイル。左中央からキャラクターを指す
export const BubbleTallLeft: React.FC<{color: string}> = ({color}) => {
  const W = 1700;
  const H = 1100;
  const L = 170; // 本体左端
  const R = 1630; // 本体右端
  const T = 40; // 本体上端
  const B = 1060; // 本体下端
  const RAD = 140; // 角丸
  const cy = (T + B) / 2;
  const d = [
    `M ${L + RAD} ${T}`,
    `H ${R - RAD}`,
    `Q ${R} ${T} ${R} ${T + RAD}`,
    `V ${B - RAD}`,
    `Q ${R} ${B} ${R - RAD} ${B}`,
    `H ${L + RAD}`,
    `Q ${L} ${B} ${L} ${B - RAD}`,
    `V ${cy + 55}`,
    `L 25 ${cy + 10}`,
    `L ${L} ${cy - 55}`,
    `V ${T + RAD}`,
    `Q ${L} ${T} ${L + RAD} ${T}`,
    'Z',
  ].join(' ');
  return (
    <AbsoluteFill>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d={d} fill="#FFFFFF" stroke={color} strokeWidth={14} strokeLinejoin="round" />
      </svg>
    </AbsoluteFill>
  );
};

// タップ箇所などの強調用フレーム(枠線のみ・透過)。Still の canvas いっぱいに描く
export const HighlightFrame: React.FC<{color: string}> = ({color}) => (
  <AbsoluteFill style={{padding: 20}}>
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 48,
        border: `16px solid ${color}`,
        boxSizing: 'border-box',
      }}
    />
  </AbsoluteFill>
);

export const BubbleAsset: React.FC<{
  color: string;
  tail: boolean;
}> = ({color, tail}) => (
  <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div
        style={{
          width: 1400,
          height: 540,
          borderRadius: 90,
          backgroundColor: '#FFFFFF',
          border: `10px solid ${color}`,
          boxShadow: '0 20px 60px rgba(51, 57, 92, 0.10)',
          boxSizing: 'border-box',
        }}
      />
      {tail ? (
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: '46px solid transparent',
            borderRight: '46px solid transparent',
            borderTop: `66px solid ${color}`,
          }}
        />
      ) : null}
    </div>
  </AbsoluteFill>
);
