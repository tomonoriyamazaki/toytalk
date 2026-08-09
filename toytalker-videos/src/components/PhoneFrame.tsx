import React from 'react';
import {COLORS} from '../theme';

// アプリ画面のスマホフレーム(コンセプトの振り返り画面 / 声変えの設定画面で共用)
export const PhoneFrame: React.FC<{
  width?: number;
  height?: number;
  alpha: number;
  children: React.ReactNode;
}> = ({width = 360, height = 600, alpha, children}) => (
  <div
    style={{
      width,
      height,
      borderRadius: 44,
      backgroundColor: '#FFFFFF',
      border: `3px solid ${COLORS.border}`,
      boxShadow: '0 10px 30px rgba(51, 57, 92, 0.12)',
      boxSizing: 'border-box',
      overflow: 'hidden',
      opacity: alpha,
      transform: `translateY(${(1 - alpha) * 18}px)`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    }}
  >
    {/* ノッチ */}
    <div
      style={{
        width: 110,
        height: 12,
        borderRadius: 6,
        backgroundColor: COLORS.border,
        marginTop: 16,
        marginBottom: 8,
        flexShrink: 0,
      }}
    />
    <div style={{flex: 1, width: '100%', padding: '8px 24px 24px', boxSizing: 'border-box'}}>
      {children}
    </div>
  </div>
);
