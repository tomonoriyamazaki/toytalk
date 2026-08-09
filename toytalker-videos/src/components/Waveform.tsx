import React from 'react';

// 再生中の波形バー。高さは sin(t*freq + i*phase) で揺れる
// デフォルトはピル内蔵サイズ(4本・8px幅)。声変え動画では大型化して使う
export const Waveform: React.FC<{
  t: number;
  color: string;
  barCount?: number;
  barWidth?: number;
  gap?: number;
  minHeight?: number;
  amplitude?: number;
  freq?: number;
  phase?: number;
  scale?: number; // 0で無音(最小高さ)、1でフル振幅
}> = ({
  t,
  color,
  barCount = 4,
  barWidth = 8,
  gap = 6,
  minHeight = 14,
  amplitude = 14,
  freq = 7,
  phase = 1.1,
  scale = 1,
}) => {
  const maxH = minHeight + amplitude;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        height: maxH,
      }}
    >
      {Array.from({length: barCount}, (_, i) => {
        const h = minHeight + amplitude * scale * Math.abs(Math.sin(t * freq + i * phase));
        return (
          <div
            key={i}
            style={{
              width: barWidth,
              height: h,
              borderRadius: barWidth / 3,
              backgroundColor: color,
            }}
          />
        );
      })}
    </div>
  );
};
