import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS, SIZES} from '../theme';
import {appear} from '../anim';
import {Waveform} from './Waveform';

export type PillKind = 'text' | 'audio';

// チャンクピル。テキストチャンク / 音声チャンク(待機) / 再生中 の3状態
// 再生中は波形バーをピル内に統合(改善要望3)
export const Pill: React.FC<{
  text: string;
  startSec: number;
  kind: PillKind;
  playing?: boolean;
}> = ({text, startSec, kind, playing = false}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const a = appear(frame, fps, startSec);
  if (a <= 0.01) return null;

  const c = playing
    ? COLORS.pillPlaying
    : kind === 'text'
      ? COLORS.pillText
      : COLORS.pillAudio;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 64,
        borderRadius: 32,
        padding: '0 28px',
        backgroundColor: c.fill,
        border: `2px solid ${c.border}`,
        color: c.text,
        fontSize: SIZES.pill,
        whiteSpace: 'nowrap',
        opacity: a,
        transform: `translateY(${(1 - a) * 18}px)`,
      }}
    >
      {text}
      {playing ? (
        <div style={{marginLeft: 16}}>
          <Waveform t={t} color={c.text} />
        </div>
      ) : null}
    </div>
  );
};
