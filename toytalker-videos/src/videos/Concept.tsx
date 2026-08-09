import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS, OVERLAY_ALPHA, OVERLAY_RGB, SIZES} from '../theme';
import {FONT} from '../fonts';
import {appear, easeCubic} from '../anim';
import {Pendant} from '../components/Pendant';
import {PhoneFrame} from '../components/PhoneFrame';

// 動画2「コンセプト」15.0秒 / 450フレーム
//
// シーンA 0.4-5.2 : 4cmペンダント → ぬいぐるみに装着
// シーンB 5.6-9.4 : 子供とぬいぐるみの会話
// シーンC 9.8-12.7: 親がアプリで会話を振り返る
// 12.9-           : 締め「はなして、みまもる。ToyTalker」
// 14.2-15.0       : フェードアウト(ループ用)

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// 吹き出し(下向きのしっぽ付き)
const Bubble: React.FC<{
  text: string;
  alpha: number;
  borderColor?: string;
}> = ({text, alpha, borderColor = COLORS.border}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      opacity: alpha,
      transform: `translateY(${(1 - alpha) * 18}px)`,
    }}
  >
    <div
      style={{
        padding: '20px 36px',
        borderRadius: 28,
        backgroundColor: '#FFFFFF',
        border: `3px solid ${borderColor}`,
        boxShadow: '0 6px 18px rgba(51, 57, 92, 0.10)',
        fontSize: SIZES.pill,
        fontWeight: 700,
        color: COLORS.text,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
    <div
      style={{
        width: 0,
        height: 0,
        borderLeft: '14px solid transparent',
        borderRight: '14px solid transparent',
        borderTop: `20px solid ${borderColor}`,
      }}
    />
  </div>
);

// アプリの会話ログ1行
const ChatRow: React.FC<{
  icon: string;
  text: string;
  alpha: number;
  mine?: boolean;
}> = ({icon, text, alpha, mine}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexDirection: mine ? 'row' : 'row-reverse',
      justifyContent: 'flex-end',
      opacity: alpha,
      transform: `translateY(${(1 - alpha) * 12}px)`,
    }}
  >
    <div
      style={{
        padding: '10px 16px',
        borderRadius: 16,
        backgroundColor: mine ? COLORS.pillText.fill : COLORS.pillAudio.fill,
        color: mine ? COLORS.pillText.text : COLORS.pillAudio.text,
        fontSize: 22,
        fontWeight: 700,
        maxWidth: 230,
      }}
    >
      {text}
    </div>
    <div style={{fontSize: 32}}>{icon}</div>
  </div>
);

export const Concept: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const t = frame / fps;

  const fadeStart = durationInFrames / fps - 0.8;
  const fade = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / 0.8) : 1;

  const aOut = easeCubic(t, 5.2, 0.4);
  const bOut = easeCubic(t, 9.4, 0.4);
  const cOut = easeCubic(t, 12.7, 0.4);

  // シーンA: ペンダントがぬいぐるみへ移動・縮小
  const pend = appear(frame, fps, 0.4);
  const bearA = appear(frame, fps, 2.6);
  const attach = easeCubic(t, 2.6, 0.7);
  const pendSize = lerp(200, 84, attach);
  const pendCX = 960;
  const pendCY = lerp(400, 552, attach);
  const copy1 = appear(frame, fps, 0.7) * (1 - easeCubic(t, 2.4, 0.3));
  const copy2 = appear(frame, fps, 3.3);

  // シーンB
  const child = appear(frame, fps, 5.6);
  const bub1 = appear(frame, fps, 6.0);
  const bearB = appear(frame, fps, 5.6);
  const bub2 = appear(frame, fps, 7.3);
  const copyB = appear(frame, fps, 8.4);

  // シーンC
  const phone = appear(frame, fps, 9.8);
  const row1 = appear(frame, fps, 10.4);
  const row2 = appear(frame, fps, 10.9);
  const parent = appear(frame, fps, 10.2);
  const copyC = appear(frame, fps, 11.3);

  // 締め
  const close = easeCubic(t, 12.9, 0.5);
  const closeMain = appear(frame, fps, 13.0);
  const closeBrand = appear(frame, fps, 13.5);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg, fontFamily: FONT}}>
      <AbsoluteFill style={{opacity: fade}}>
        {/* シーンA: ペンダント → ぬいぐるみ装着 */}
        {aOut < 1 ? (
          <AbsoluteFill style={{opacity: 1 - aOut, transform: `translateY(${-30 * aOut}px)`}}>
            {bearA > 0 ? (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 260,
                  textAlign: 'center',
                  fontSize: 300,
                  lineHeight: 1,
                  opacity: bearA,
                  transform: `translateY(${(1 - bearA) * 18}px)`,
                }}
              >
                🧸
              </div>
            ) : null}
            <div
              style={{
                position: 'absolute',
                left: pendCX - pendSize / 2,
                top: pendCY - pendSize / 2,
                opacity: pend,
                transform: `translateY(${(1 - pend) * 18}px)`,
              }}
            >
              <Pendant size={pendSize} strap={attach < 0.9} />
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 740,
                textAlign: 'center',
                fontSize: 52,
                fontWeight: 700,
                color: COLORS.text,
                opacity: copy1,
              }}
            >
              4cmの、おしゃべりペンダント。
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 740,
                textAlign: 'center',
                fontSize: 52,
                fontWeight: 700,
                color: COLORS.text,
                opacity: copy2,
                transform: `translateY(${(1 - copy2) * 18}px)`,
              }}
            >
              ぬいぐるみに、つけるだけ。
            </div>
          </AbsoluteFill>
        ) : null}

        {/* シーンB: 子供とぬいぐるみの会話 */}
        {t >= 5.6 && bOut < 1 ? (
          <AbsoluteFill style={{opacity: 1 - bOut, transform: `translateY(${-30 * bOut}px)`}}>
            {/* 子供 */}
            <div
              style={{
                position: 'absolute',
                left: 300,
                top: 540,
                fontSize: 200,
                lineHeight: 1,
                opacity: child,
              }}
            >
              👧
            </div>
            <div style={{position: 'absolute', left: 180, top: 370}}>
              <Bubble text="きょうね、ようちえんで ワニさんつくったの！" alpha={bub1} borderColor={COLORS.coral} />
            </div>
            {/* ぬいぐるみ(ペンダント装着) */}
            <div
              style={{
                position: 'absolute',
                left: 1380,
                top: 540,
                fontSize: 200,
                lineHeight: 1,
                opacity: bearB,
              }}
            >
              🧸
            </div>
            <div style={{position: 'absolute', left: 1462, top: 690, opacity: bearB}}>
              <Pendant size={52} strap={false} />
            </div>
            <div style={{position: 'absolute', right: 220, top: 370}}>
              <Bubble text="わあ、みてみたいな！どんな いろ？" alpha={bub2} borderColor={COLORS.teal} />
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 850,
                textAlign: 'center',
                fontSize: 52,
                fontWeight: 700,
                color: COLORS.text,
                opacity: copyB,
                transform: `translateY(${(1 - copyB) * 18}px)`,
              }}
            >
              こどもの、話し相手に。
            </div>
          </AbsoluteFill>
        ) : null}

        {/* シーンC: 親がアプリで振り返り */}
        {t >= 9.8 && cOut < 1 ? (
          <AbsoluteFill style={{opacity: 1 - cOut, transform: `translateY(${-30 * cOut}px)`}}>
            <div style={{position: 'absolute', left: 440, top: 240}}>
              <PhoneFrame alpha={phone}>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    color: COLORS.text,
                    textAlign: 'center',
                    marginBottom: 20,
                  }}
                >
                  きょうのおはなし
                </div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
                  <ChatRow icon="👧" text="ようちえんで ワニさんつくったの！" alpha={row1} mine />
                  <ChatRow icon="🧸" text="わあ、みてみたいな！" alpha={row2} />
                </div>
              </PhoneFrame>
            </div>
            <div
              style={{
                position: 'absolute',
                left: 1120,
                top: 380,
                fontSize: 180,
                lineHeight: 1,
                opacity: parent,
              }}
            >
              👩
            </div>
            <div
              style={{
                position: 'absolute',
                left: 970,
                top: 630,
                width: 700,
                fontSize: SIZES.title,
                fontWeight: 700,
                color: COLORS.text,
                opacity: copyC,
                transform: `translateY(${(1 - copyC) * 18}px)`,
              }}
            >
              どんな話をしたか、
              <br />
              あとからアプリでみられる。
            </div>
          </AbsoluteFill>
        ) : null}

        {/* 締め */}
        {close > 0 ? (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(${OVERLAY_RGB}, ${OVERLAY_ALPHA * close})`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 36,
            }}
          >
            <div
              style={{
                fontSize: SIZES.bigHead,
                fontWeight: 700,
                color: COLORS.teal,
                opacity: closeMain,
                transform: `translateY(${(1 - closeMain) * 18}px)`,
              }}
            >
              はなして、みまもる。
            </div>
            <div
              style={{
                fontSize: SIZES.midLine,
                color: COLORS.textSub,
                opacity: closeBrand,
                transform: `translateY(${(1 - closeBrand) * 18}px)`,
              }}
            >
              ToyTalker
            </div>
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
