import React from 'react';
import {COLORS} from '../theme';

// ToyTalker Mini(4cm正方形ペンダント型デバイス)のイラスト表現
// size = 本体一辺のpx。ストラップループ付き
export const Pendant: React.FC<{
  size?: number;
  strap?: boolean;
}> = ({size = 120, strap = true}) => {
  const dot = Math.max(4, size * 0.055);
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      {strap ? (
        <div
          style={{
            width: size * 0.22,
            height: size * 0.16,
            borderRadius: size * 0.08,
            border: `${Math.max(3, size * 0.045)}px solid ${COLORS.accent}`,
            borderBottom: 'none',
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            boxSizing: 'border-box',
          }}
        />
      ) : null}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: '#FFFFFF',
          border: `${Math.max(3, size * 0.04)}px solid ${COLORS.accent}`,
          boxShadow: '0 6px 18px rgba(51, 57, 92, 0.15)',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: size * 0.12,
        }}
      >
        {/* スピーカー穴 */}
        <div style={{display: 'flex', flexDirection: 'column', gap: dot * 0.9}}>
          {[0, 1, 2].map((r) => (
            <div key={r} style={{display: 'flex', gap: dot * 0.9}}>
              {[0, 1, 2].map((c) => (
                <div
                  key={c}
                  style={{
                    width: dot,
                    height: dot,
                    borderRadius: dot / 2,
                    backgroundColor: COLORS.border,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        {/* LED */}
        <div
          style={{
            width: dot * 1.4,
            height: dot * 1.4,
            borderRadius: dot,
            backgroundColor: COLORS.teal,
          }}
        />
      </div>
    </div>
  );
};
