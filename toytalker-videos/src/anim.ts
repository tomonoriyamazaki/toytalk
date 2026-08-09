import {spring} from 'remotion';

// プロトタイプ(render.py)の ease(): cubic ease-out。タイミング検証の基準
export const easeCubic = (t: number, t0: number, d = 0.35): number => {
  const x = (t - t0) / d;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 1 - (1 - x) ** 3;
};

// 出現アニメ(改善要望1): spring ベース。開始時刻はイベント表を厳守
export const appear = (frame: number, fps: number, startSec: number): number => {
  const f = frame - startSec * fps;
  if (f < 0) return 0;
  return spring({
    frame: f,
    fps,
    config: {damping: 200},
    durationInFrames: Math.round(0.35 * fps),
  });
};

// 等速タイピング
export const typed = (t: number, t0: number, t1: number, s: string): string => {
  if (t < t0) return '';
  const n = Math.floor(s.length * Math.min(1, (t - t0) / (t1 - t0)));
  return s.slice(0, n);
};
