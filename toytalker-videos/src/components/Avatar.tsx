import React from 'react';

// 子供・親のフラットイラスト顔(絵文字の代わり)。Pendant と同じ雰囲気の描き味
// variant: child = おさげの子供 / parent = ロングヘアの親
export const Avatar: React.FC<{
  variant: 'child' | 'parent';
  size?: number;
}> = ({variant, size = 180}) => {
  const s = size;
  const skin = '#FFDFC4';
  const hair = variant === 'child' ? '#B5714F' : '#6E4630';
  const line = '#4A3527';
  const cheek = '#FFB9A3';

  const px = (n: number) => n * s;

  return (
    <div style={{position: 'relative', width: s, height: s}}>
      {/* 髪(後ろ) */}
      {variant === 'child' ? (
        <>
          {/* 頭頂のちょんまげ結び */}
          <div
            style={{
              position: 'absolute',
              left: px(0.4),
              top: px(-0.02),
              width: px(0.2),
              height: px(0.18),
              borderRadius: '50%',
              backgroundColor: hair,
            }}
          />
        </>
      ) : (
        <>
          {/* ロングヘア(肩まで) */}
          <div
            style={{
              position: 'absolute',
              left: px(0.02),
              top: px(0.1),
              width: px(0.96),
              height: px(0.85),
              borderRadius: `${px(0.48)}px ${px(0.48)}px ${px(0.2)}px ${px(0.2)}px`,
              backgroundColor: hair,
            }}
          />
        </>
      )}

      {/* 顔 */}
      <div
        style={{
          position: 'absolute',
          left: px(0.11),
          top: px(0.14),
          width: px(0.78),
          height: px(0.74),
          borderRadius: '50%',
          backgroundColor: skin,
        }}
      />

      {/* 前髪 */}
      <div
        style={{
          position: 'absolute',
          left: px(0.11),
          top: px(0.1),
          width: px(0.78),
          height: px(0.3),
          borderRadius: `${px(0.39)}px ${px(0.39)}px ${px(0.1)}px ${px(0.1)}px`,
          backgroundColor: hair,
        }}
      />

      {/* 目 */}
      <div
        style={{
          position: 'absolute',
          left: px(0.31),
          top: px(0.52),
          width: px(0.07),
          height: px(0.09),
          borderRadius: '50%',
          backgroundColor: line,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: px(0.62),
          top: px(0.52),
          width: px(0.07),
          height: px(0.09),
          borderRadius: '50%',
          backgroundColor: line,
        }}
      />

      {/* ほっぺ */}
      <div
        style={{
          position: 'absolute',
          left: px(0.2),
          top: px(0.63),
          width: px(0.11),
          height: px(0.08),
          borderRadius: '50%',
          backgroundColor: cheek,
          opacity: 0.8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: px(0.69),
          top: px(0.63),
          width: px(0.11),
          height: px(0.08),
          borderRadius: '50%',
          backgroundColor: cheek,
          opacity: 0.8,
        }}
      />

      {/* 口(にっこり) */}
      <div
        style={{
          position: 'absolute',
          left: px(0.42),
          top: px(0.6),
          width: px(0.16),
          height: px(0.1),
          borderRadius: '0 0 50% 50%',
          borderBottom: `${Math.max(3, px(0.028))}px solid ${line}`,
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
};
