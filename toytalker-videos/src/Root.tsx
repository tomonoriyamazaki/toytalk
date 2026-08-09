import React from 'react';
import {Composition} from 'remotion';
import {ResponseSpeed} from './videos/ResponseSpeed';
import {Concept} from './videos/Concept';
import {VoiceChange} from './videos/VoiceChange';

// 尺・fps・解像度はここで一元管理(改善要望5)
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const sec = (s: number) => Math.round(s * FPS);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 3. 応答速度(30秒: イントロ12秒 + 本編1.2倍スロー) */}
      <Composition
        id="ResponseSpeed"
        component={ResponseSpeed}
        durationInFrames={sec(30)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* 2. コンセプト(15秒) */}
      <Composition
        id="Concept"
        component={Concept}
        durationInFrames={sec(15)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* 4. 声変え(15秒) */}
      <Composition
        id="VoiceChange"
        component={VoiceChange}
        durationInFrames={sec(15)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
