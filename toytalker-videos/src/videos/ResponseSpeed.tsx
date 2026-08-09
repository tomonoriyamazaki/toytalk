import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS, DEVICE_PHOTO, OVERLAY_ALPHA, OVERLAY_RGB, SIZES} from '../theme';
import {FONT} from '../fonts';
import {appear, easeCubic, typed} from '../anim';
import {StageArrow, StageCard} from '../components/StageCard';
import {Pill} from '../components/Pill';
import {Caption, Subtitle} from '../components/Subtitle';

// 動画3「応答速度」30.0秒 / 900フレーム
//
// イントロ 0-12秒: STT/LLM/TTS の3ステップを予備知識ゼロ向けに説明
// 本編 12秒-: パイプライン並行動作のアニメ(reference/render.py のイベント表を
//             12秒オフセット + 1.2倍スローで再生。相対タイミングはプロトタイプ準拠)

const INTRO_END = 12.0;
const SCALE = 1.2;
// プロトタイプのイベント表時刻 → 本動画の時刻
const m = (s: number) => INTRO_END + s * SCALE;

const FULL = 'こんにちは！今日はいい天気だね。何をお話ししようか？';
const STT_S = 'こんにちは';

const INTRO_STEPS: {icon: string; name: string; label: string; desc: string; at: number}[] = [
  {icon: '🎤', name: 'STT', label: '音声認識', desc: 'こえを もじにする', at: 0.8},
  {icon: '💭', name: 'LLM', label: 'AI', desc: 'へんじを かんがえる', at: 3.0},
  {icon: '🔊', name: 'TTS', label: '音声合成', desc: 'もじを こえにする', at: 5.2},
];

const CAPTIONS: Caption[] = [
  {at: m(0.2), text: '① 発話をSTTがリアルタイムに文字起こし'},
  {at: m(1.8), text: '② 確定した瞬間、即LLMへ。返答はストリーミング生成'},
  {at: m(2.9), text: '③ 文の区切りごとに、生成完了を待たずTTSへ'},
  {at: m(3.6), text: '④ 最初の音声が届き次第、すぐ再生開始'},
  {at: m(5.05), text: '⑤ 再生の裏で、後続の音声をため込む'},
  {at: m(7.0), text: '⑥ 生成を待たずに連続再生'},
  {at: m(11.0), text: ''},
];

const STAGES: {name: string; role: string; activeSec: number}[] = [
  {name: 'STT', role: '音声認識', activeSec: m(0.2)},
  {name: 'LLM', role: '返答生成', activeSec: m(1.8)},
  {name: 'TTS', role: '音声合成', activeSec: m(2.9)},
  {name: 'デバイス', role: '再生', activeSec: m(3.6)},
];

const stageStatus = (t: number): string[] => {
  const s = ['待機中', '待機中', '待機中', '待機中'];
  if (t >= m(0.2)) s[0] = '認識中…';
  if (t >= m(1.75)) s[0] = '確定 → 即LLMへ';
  if (t >= m(1.8)) s[1] = 'ストリーミング生成中…';
  if (t >= m(5.7)) s[1] = '生成完了';
  if (t >= m(2.9)) s[2] = '文の区切りごとに合成';
  if (t >= m(3.6)) s[3] = '再生中';
  if (t >= m(10.6)) s[3] = '再生完了';
  return s;
};

// TTSキュー: (テキスト, 出現時刻)
const TTS_QUEUE: [string, number][] = [
  ['こんにちは！', m(2.9)],
  ['今日はいい天気だね。', m(4.35)],
  ['何をお話ししようか？', m(5.75)],
];

// デバイス再生: (テキスト, 出現, 再生開始, 再生終了)
const PLAYS: [string, number, number, number][] = [
  ['こんにちは！', m(3.6), m(3.6), m(7.0)],
  ['今日はいい天気だね。', m(5.05), m(7.0), m(8.8)],
  ['何をお話ししようか？', m(6.45), m(8.8), m(10.6)],
];

const LANES = ['ユーザー発話', 'LLM ストリーム', 'TTS キュー', 'デバイス再生'];

const LANE_Y = 360;
const LANE_H = 120;
const CONTENT_X = 340;

export const ResponseSpeed: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const t = frame / fps;

  // 末尾0.8秒フェードアウト(ループ用)
  const fadeStart = durationInFrames / fps - 0.8;
  const fade = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / 0.8) : 1;

  // イントロ
  const introOut = easeCubic(t, INTRO_END - 0.9, 0.5);
  const introTitle = appear(frame, fps, 0.3);
  const introLine1 = appear(frame, fps, 7.6);
  const introLine2 = appear(frame, fps, 9.4);

  // 本編
  const ga = easeCubic(t, INTRO_END, 0.4);
  const subs = stageStatus(t);
  const stt = typed(t, m(0.8), m(1.7), STT_S);
  const llm = typed(t, m(1.9), m(5.6), FULL);
  const cursorOn = t < m(5.7) && Math.floor(t * 2) % 2 === 0;
  const nbuf = PLAYS.filter(([, t0, ps]) => t0 <= t && t < ps).length;
  const summary = easeCubic(t, m(11.0), 0.5);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg, fontFamily: FONT}}>
      <AbsoluteFill style={{opacity: fade}}>
        {/* ===== イントロ: 3ステップ説明 ===== */}
        {introOut < 1 ? (
          <AbsoluteFill style={{opacity: 1 - introOut, transform: `translateY(${-30 * introOut}px)`}}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 150,
                textAlign: 'center',
                fontSize: 56,
                fontWeight: 700,
                color: COLORS.text,
                opacity: introTitle,
                transform: `translateY(${(1 - introTitle) * 18}px)`,
              }}
            >
              ToyTalkerは、どうやって おしゃべりしてるの？
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 340,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 24,
              }}
            >
              {INTRO_STEPS.map((step, i) => {
                const a = appear(frame, fps, step.at);
                return (
                  <React.Fragment key={step.name}>
                    {i > 0 ? (
                      <div
                        style={{
                          fontSize: 48,
                          color: COLORS.textSub,
                          opacity: a,
                        }}
                      >
                        →
                      </div>
                    ) : null}
                    <div
                      style={{
                        width: 400,
                        height: 260,
                        borderRadius: 24,
                        backgroundColor: COLORS.card,
                        border: `3px solid ${COLORS.border}`,
                        boxShadow: '0 6px 18px rgba(51, 57, 92, 0.08)',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 12,
                        opacity: a,
                        transform: `translateY(${(1 - a) * 18}px)`,
                      }}
                    >
                      <div style={{fontSize: 64, lineHeight: 1}}>{step.icon}</div>
                      <div style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
                        <span style={{fontSize: SIZES.stage, fontWeight: 700, color: COLORS.text}}>
                          {step.name}
                        </span>
                        <span style={{fontSize: SIZES.note, color: COLORS.textSub}}>{step.label}</span>
                      </div>
                      <div style={{fontSize: SIZES.pill, fontWeight: 700, color: COLORS.accent}}>
                        {step.desc}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 700,
                textAlign: 'center',
                fontSize: SIZES.midLine,
                color: COLORS.text,
                opacity: introLine1,
                transform: `translateY(${(1 - introLine1) * 18}px)`,
              }}
            >
              この3ステップで、おしゃべりしている。
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 790,
                textAlign: 'center',
                fontSize: 50,
                fontWeight: 700,
                color: COLORS.teal,
                opacity: introLine2,
                transform: `translateY(${(1 - introLine2) * 18}px)`,
              }}
            >
              ToyTalkerは、これをぜんぶ同時に動かす！
            </div>
          </AbsoluteFill>
        ) : null}

        {/* ===== 本編: パイプライン並行動作 ===== */}
        {t >= INTRO_END - 0.2 ? (
          <AbsoluteFill>
            {/* タイトル */}
            <div
              style={{
                position: 'absolute',
                left: 80,
                top: 46,
                fontSize: SIZES.title,
                fontWeight: 700,
                color: COLORS.text,
                opacity: ga,
              }}
            >
              応答速度のしくみ — すべてを並行に、待たない設計
            </div>

            {/* パイプライン段カード */}
            <div style={{position: 'absolute', left: 80, top: 140, display: 'flex'}}>
              {STAGES.map((st, i) => (
                <React.Fragment key={st.name}>
                  <StageCard
                    name={st.name}
                    role={st.role}
                    status={subs[i]}
                    activeSec={st.activeSec}
                    ga={ga}
                    photo={i === 3 ? DEVICE_PHOTO : null}
                  />
                  {i < 3 ? <StageArrow ga={ga} /> : null}
                </React.Fragment>
              ))}
            </div>

            {/* レーンラベルと区切り線 */}
            {LANES.map((name, i) => {
              const y = LANE_Y + i * LANE_H;
              return (
                <React.Fragment key={name}>
                  <div
                    style={{
                      position: 'absolute',
                      left: 80,
                      top: y + 20,
                      fontSize: SIZES.lane,
                      color: COLORS.textSub,
                      opacity: ga,
                    }}
                  >
                    {name}
                  </div>
                  {i < 3 ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: 80,
                        right: 80,
                        top: y + LANE_H - 8,
                        height: 2,
                        backgroundColor: COLORS.border,
                        opacity: ga,
                      }}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}

            {/* レーン1: ユーザー発話 */}
            <div style={{position: 'absolute', left: CONTENT_X, top: LANE_Y + 8}}>
              <Pill text="● 「こんにちは」" startSec={m(0.2)} kind="text" />
            </div>
            {stt ? (
              <div
                style={{
                  position: 'absolute',
                  left: CONTENT_X + 420,
                  top: LANE_Y + 22,
                  fontSize: SIZES.body,
                  color: COLORS.textSub,
                }}
              >
                文字起こし: {stt}
              </div>
            ) : null}

            {/* レーン2: LLM ストリーム */}
            {llm ? (
              <div
                style={{
                  position: 'absolute',
                  left: CONTENT_X,
                  top: LANE_Y + LANE_H + 24,
                  fontSize: SIZES.body,
                  color: COLORS.text,
                  whiteSpace: 'nowrap',
                }}
              >
                {llm}
                {cursorOn ? (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 44,
                      marginLeft: 6,
                      verticalAlign: 'middle',
                      backgroundColor: COLORS.accent,
                    }}
                  />
                ) : null}
              </div>
            ) : null}

            {/* レーン3: TTS キュー */}
            <div
              style={{
                position: 'absolute',
                left: CONTENT_X,
                top: LANE_Y + LANE_H * 2 + 12,
                display: 'flex',
                gap: 20,
              }}
            >
              {TTS_QUEUE.map(([txt, t0]) => (
                <Pill key={txt} text={txt} startSec={t0} kind="text" />
              ))}
            </div>

            {/* レーン4: デバイス再生 */}
            <div
              style={{
                position: 'absolute',
                left: CONTENT_X,
                top: LANE_Y + LANE_H * 3 + 12,
                display: 'flex',
                gap: 20,
                alignItems: 'center',
              }}
            >
              {PLAYS.map(([txt, t0, ps, pe]) => (
                <Pill
                  key={txt}
                  text={`♪ ${txt}`}
                  startSec={t0}
                  kind="audio"
                  playing={ps <= t && t < pe}
                />
              ))}
              {t >= m(3.6) && t < m(10.8) ? (
                <div style={{fontSize: SIZES.lane, color: COLORS.textSub, marginLeft: 10}}>
                  バッファ: {nbuf}
                </div>
              ) : null}
            </div>

            {/* 字幕キャプション */}
            <Subtitle captions={CAPTIONS} />

            {/* まとめ画面 */}
            {summary > 0 ? (
              <AbsoluteFill style={{backgroundColor: `rgba(${OVERLAY_RGB}, ${OVERLAY_ALPHA * summary})`}}>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 420,
                    textAlign: 'center',
                    fontSize: SIZES.midLine,
                    color: COLORS.textSub,
                    opacity: summary,
                  }}
                >
                  発話の終わりから、返事が聞こえるまで
                </div>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 500,
                    textAlign: 'center',
                    fontSize: SIZES.bigHead,
                    fontWeight: 700,
                    color: COLORS.teal,
                    opacity: summary,
                  }}
                >
                  体感レイテンシ 1秒以下
                </div>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 640,
                    textAlign: 'center',
                    fontSize: SIZES.midLine,
                    color: COLORS.text,
                    opacity: summary,
                  }}
                >
                  認識・生成・合成・再生 — すべてが同時に走っている
                </div>
              </AbsoluteFill>
            ) : null}
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
