import React from 'react';
import {Composition, Still} from 'remotion';
import {ResponseSpeed} from './videos/ResponseSpeed';
import {Concept} from './videos/Concept';
import {VoiceChange} from './videos/VoiceChange';
import {BubbleAsset, BubbleTallLeft, HighlightFrame} from './BubbleAsset';

// 尺・fps・解像度はここで一元管理(改善要望5)
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const sec = (s: number) => Math.round(s * FPS);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 3. 応答速度(44.5秒: イントロ13.5秒 + 本編3.6倍スロー) */}
      <Composition
        id="ResponseSpeed"
        component={ResponseSpeed}
        durationInFrames={sec(44.5)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* 2. コンセプト(22秒: シーンB/C/締めにホールドあり) */}
      <Composition
        id="Concept"
        component={Concept}
        durationInFrames={sec(22)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* DaVinci用 透過吹き出し素材(静止画) */}
      <Still
        id="BubbleAsset"
        component={BubbleAsset}
        width={1600}
        height={700}
        defaultProps={{color: '#FF8A5C', tail: true}}
      />
      <Still
        id="BubbleTallLeft"
        component={BubbleTallLeft}
        width={1700}
        height={1100}
        defaultProps={{color: '#12A47C'}}
      />
      {/* タップ強調用の枠(正方形/長方形) */}
      <Still
        id="HighlightSquare"
        component={HighlightFrame}
        width={800}
        height={800}
        defaultProps={{color: '#FF3B30'}}
      />
      <Still
        id="HighlightRect"
        component={HighlightFrame}
        width={1400}
        height={800}
        defaultProps={{color: '#FF3B30'}}
      />
      {/* 4. 声変え(26秒: まとめ以外2倍スロー) */}
      <Composition
        id="VoiceChange"
        component={VoiceChange}
        durationInFrames={sec(26)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
