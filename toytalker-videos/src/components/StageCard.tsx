import React from 'react';
import {Img, interpolateColors, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS, SIZES} from '../theme';
import {appear, easeCubic} from '../anim';

// パイプライン段カード(STT/LLM/TTS/デバイス)。400×150px、ステータス行つき
// photo を渡すと右側に実機写真をはめ込む(改善要望2、public/ に置く)
export const StageCard: React.FC<{
  name: string;
  role: string;
  status: string;
  activeSec: number | null;
  ga: number; // 全体出現アルファ
  photo?: string | null;
}> = ({name, role, status, activeSec, ga, photo}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const a = activeSec !== null && t >= activeSec ? appear(frame, fps, activeSec) : 0;

  const bg = interpolateColors(a, [0, 1], [COLORS.card, COLORS.cardActive]);
  const border = interpolateColors(a, [0, 1], [COLORS.border, COLORS.accent]);
  const active = a > 0;

  return (
    <div
      style={{
        position: 'relative',
        width: 400,
        height: 150,
        borderRadius: 20,
        backgroundColor: bg,
        border: `3px solid ${border}`,
        boxSizing: 'border-box',
        opacity: ga > 0 ? 1 : 0,
      }}
    >
      <div style={{position: 'absolute', left: 32, top: 24, display: 'flex', alignItems: 'baseline', gap: 20}}>
        <span style={{fontSize: SIZES.stage, fontWeight: 700, color: COLORS.text, opacity: ga}}>{name}</span>
        <span style={{fontSize: SIZES.note, color: COLORS.textSub, opacity: ga}}>{role}</span>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 32,
          top: 90,
          fontSize: SIZES.note,
          color: active ? COLORS.accent : COLORS.textSub,
          opacity: Math.max(a, ga * 0.7),
        }}
      >
        {status}
      </div>
      {photo ? (
        <Img
          src={staticFile(photo)}
          style={{
            position: 'absolute',
            right: 14,
            top: 14,
            height: 122,
            borderRadius: 12,
            objectFit: 'cover',
            opacity: ga,
          }}
        />
      ) : null}
    </div>
  );
};

// カード間の「→」
export const StageArrow: React.FC<{ga: number}> = ({ga}) => (
  <div
    style={{
      width: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: SIZES.stage,
      color: COLORS.textSub,
      opacity: ga,
    }}
  >
    →
  </div>
);
