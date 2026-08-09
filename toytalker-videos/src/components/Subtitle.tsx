import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {CAPTION, COLORS} from '../theme';
import {easeCubic} from '../anim';

export type Caption = {at: number; text: string};

// 共通字幕(番号付きキャプション)。下部中央、角丸背景
// 切り替え時はクロスフェード(改善要望4)。text が空のエントリで非表示になる
export const Subtitle: React.FC<{
  captions: Caption[];
  fontSize?: number;
}> = ({captions, fontSize = CAPTION.fontSize}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;

  return (
    <>
      {captions.map((cap, i) => {
        if (!cap.text) return null;
        const fadeIn = easeCubic(t, cap.at, CAPTION.crossfadeSec);
        const next = captions[i + 1];
        const fadeOut = next ? 1 - easeCubic(t, next.at, CAPTION.crossfadeSec) : 1;
        const a = fadeIn * fadeOut;
        if (a <= 0.01) return null;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 950,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                height: 90,
                display: 'flex',
                alignItems: 'center',
                padding: `0 ${CAPTION.paddingX}px`,
                borderRadius: CAPTION.radius,
                backgroundColor: CAPTION.bg,
                border: `2px solid ${COLORS.border}`,
                boxShadow: '0 4px 16px rgba(51, 57, 92, 0.08)',
                opacity: a,
                fontSize,
                fontWeight: 700,
                color: COLORS.text,
                whiteSpace: 'nowrap',
              }}
            >
              {cap.text}
            </div>
          </div>
        );
      })}
    </>
  );
};
