import React from 'react';
import {AbsoluteFill, interpolateColors, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS, OVERLAY_ALPHA, OVERLAY_RGB, SIZES} from '../theme';
import {FONT} from '../fonts';
import {appear, easeCubic} from '../anim';
import {Waveform} from '../components/Waveform';
import {Caption, Subtitle} from '../components/Subtitle';
import {PhoneFrame} from '../components/PhoneFrame';
import {Pendant} from '../components/Pendant';

// 動画4「声変え」26.0秒 / 780フレーム
// アプリでキャラクターを作成(名前・性格・声)→ おもちゃに反映される流れ。
// 声はキャラ音声 → クローンボイス(家族の声)に切替可能なことを波形の色で表現
// まとめ画面以外は2倍スロー(まとめの表示時間は等倍のまま)
//
// 0.8  : アプリ画面出現、設定行が順に埋まる(名前/性格/声)、字幕①
// 6.8  : 送信エフェクト → ぬいぐるみが設定どおりの声で話す(緑)
// 13.6 : アプリで声をクローンボイスに変更、字幕②
// 14.8 : 送信エフェクト → 同じセリフが紫(おかあさんの声)に
// 21.2 : 再生停止
// 22.4 : まとめ画面
// 25.2 : フェードアウト(ループ用)

const PHRASE = 'こんにちは！ぼく、ぽんちゃん！';
const SWITCH_T = 13.6;
const REPLAY_T = 15.6;
const STOP_T = 21.2;

const VOICES = [
  {name: 'ずんだもん', tag: 'キャラ音声', main: '#22B583', deep: '#0F7A5A'},
  {name: 'おかあさんの声', tag: 'クローン β', main: '#7C6FE0', deep: '#4A3FB5'},
];

const CAPTIONS: Caption[] = [
  {at: 1.0, text: '① アプリで、性格と声をきめる'},
  {at: SWITCH_T, text: '② 自分の声も、クローンでつくれる'},
  {at: 22.4, text: ''},
];

// アプリの設定行
const SettingRow: React.FC<{
  label: string;
  alpha: number;
  children: React.ReactNode;
}> = ({label, alpha, children}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      opacity: alpha,
      transform: `translateY(${(1 - alpha) * 12}px)`,
    }}
  >
    <div style={{fontSize: 20, color: COLORS.textSub, fontWeight: 700}}>{label}</div>
    {children}
  </div>
);

const FieldBox: React.FC<{children: React.ReactNode; borderColor?: string; bg?: string}> = ({
  children,
  borderColor = COLORS.border,
  bg = '#FFFFFF',
}) => (
  <div
    style={{
      padding: '12px 18px',
      borderRadius: 14,
      border: `2px solid ${borderColor}`,
      backgroundColor: bg,
      fontSize: 24,
      fontWeight: 700,
      color: COLORS.text,
    }}
  >
    {children}
  </div>
);

export const VoiceChange: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const t = frame / fps;

  const fadeStart = durationInFrames / fps - 0.8;
  const fade = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / 0.8) : 1;

  const phone = appear(frame, fps, 0.8);
  const rowName = appear(frame, fps, 2.0);
  const rowPersona = appear(frame, fps, 3.6);
  const rowVoice = appear(frame, fps, 5.2);

  // 声の切替(0=キャラ音声, 1=クローン)
  const sw = easeCubic(t, SWITCH_T, 0.5);
  const waveColor = interpolateColors(sw, [0, 1], [VOICES[0].main, VOICES[1].main]);
  const waveDeep = interpolateColors(sw, [0, 1], [VOICES[0].deep, VOICES[1].deep]);

  // 送信エフェクト(アプリ→おもちゃ)。設定直後と声変更直後の2回流れる
  const sendWindow = (t0: number) => t >= t0 && t < t0 + 2.0;
  const sending = sendWindow(6.8) || sendWindow(14.8);

  const bear = appear(frame, fps, 7.2);
  const bubble = appear(frame, fps, 7.8);

  // 再生中のみ波形が揺れる(切替時にいったん絞って再生し直す)
  const playing =
    easeCubic(t, 8.2, 0.4) *
    (1 - easeCubic(t, STOP_T, 0.4)) *
    (1 - (easeCubic(t, SWITCH_T, 0.3) - easeCubic(t, REPLAY_T, 0.4)));

  const summary = easeCubic(t, 22.4, 0.5);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg, fontFamily: FONT}}>
      <AbsoluteFill style={{opacity: fade}}>
        {/* 左: アプリ(キャラクター設定) */}
        <div style={{position: 'absolute', left: 300, top: 200}}>
          <PhoneFrame alpha={phone} height={640}>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: COLORS.text,
                textAlign: 'center',
                marginBottom: 24,
              }}
            >
              キャラクターをつくる
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 22}}>
              <SettingRow label="なまえ" alpha={rowName}>
                <FieldBox>ぽんちゃん</FieldBox>
              </SettingRow>
              <SettingRow label="せいかく" alpha={rowPersona}>
                <FieldBox>やさしくて、おしゃべりずき</FieldBox>
              </SettingRow>
              <SettingRow label="こえ" alpha={rowVoice}>
                <div style={{position: 'relative'}}>
                  <div style={{opacity: 1 - sw, position: sw > 0.5 ? 'absolute' : 'static', inset: 0}}>
                    <FieldBox borderColor={VOICES[0].main} bg="#E0F6EE">
                      ♪ {VOICES[0].name}
                      <span style={{fontSize: 18, color: COLORS.textSub, marginLeft: 10}}>
                        {VOICES[0].tag}
                      </span>
                    </FieldBox>
                  </div>
                  <div style={{opacity: sw, position: sw > 0.5 ? 'static' : 'absolute', inset: 0}}>
                    <FieldBox borderColor={VOICES[1].main} bg="#EDEAFF">
                      ♪ {VOICES[1].name}
                      <span style={{fontSize: 18, color: COLORS.textSub, marginLeft: 10}}>
                        {VOICES[1].tag}
                      </span>
                    </FieldBox>
                  </div>
                </div>
              </SettingRow>
            </div>
          </PhoneFrame>
        </div>

        {/* 送信エフェクト(アプリ→おもちゃ) */}
        {sending ? (
          <div
            style={{
              position: 'absolute',
              left: 740,
              top: 520,
              display: 'flex',
              gap: 26,
              alignItems: 'center',
            }}
          >
            {[0, 1, 2].map((i) => {
              const phase = (t * 3 - i * 0.33) % 1;
              return (
                <div
                  key={i}
                  style={{
                    fontSize: 44,
                    fontWeight: 700,
                    color: waveColor,
                    opacity: 0.25 + 0.75 * Math.max(0, Math.sin(phase * Math.PI)),
                  }}
                >
                  »
                </div>
              );
            })}
          </div>
        ) : null}

        {/* 右: ぬいぐるみ(ペンダント装着)が話す */}
        <div
          style={{
            position: 'absolute',
            left: 1150,
            top: 460,
            fontSize: 260,
            lineHeight: 1,
            opacity: bear,
            transform: `translateY(${(1 - bear) * 18}px)`,
          }}
        >
          🧸
        </div>
        <div style={{position: 'absolute', left: 1297, top: 610, opacity: bear}}>
          <Pendant size={64} strap={false} />
        </div>
        {/* 吹き出し(声の色で枠が変わる) */}
        <div
          style={{
            position: 'absolute',
            left: 1000,
            top: 250,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            opacity: bubble,
            transform: `translateY(${(1 - bubble) * 18}px)`,
          }}
        >
          <div
            style={{
              padding: '24px 44px',
              borderRadius: 32,
              backgroundColor: '#FFFFFF',
              border: `3px solid ${waveColor}`,
              boxShadow: '0 6px 18px rgba(51, 57, 92, 0.10)',
              fontSize: 40,
              fontWeight: 700,
              color: COLORS.text,
              whiteSpace: 'nowrap',
            }}
          >
            {PHRASE}
          </div>
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: '16px solid transparent',
              borderRight: '16px solid transparent',
              borderTop: `22px solid ${waveColor}`,
            }}
          />
        </div>
        {/* 波形 + 現在の声 */}
        <div
          style={{
            position: 'absolute',
            left: 1050,
            width: 480,
            top: 770,
            display: 'flex',
            justifyContent: 'center',
            opacity: bubble,
          }}
        >
          <Waveform
            t={t}
            color={waveColor}
            barCount={18}
            barWidth={12}
            gap={8}
            minHeight={16}
            amplitude={60}
            freq={7}
            phase={0.7}
            scale={playing}
          />
        </div>
        <div
          style={{
            position: 'absolute',
            left: 1050,
            width: 480,
            top: 880,
            textAlign: 'center',
            fontSize: SIZES.lane,
            fontWeight: 700,
            color: waveDeep,
            opacity: bubble,
          }}
        >
          {sw < 0.5 ? `♪ ${VOICES[0].name}の声` : `♪ ${VOICES[1].name}`}
        </div>

        {/* 字幕キャプション */}
        <Subtitle captions={CAPTIONS} />

        {/* まとめ画面 */}
        {summary > 0 ? (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(${OVERLAY_RGB}, ${OVERLAY_ALPHA * summary})`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 40,
            }}
          >
            <div
              style={{
                fontSize: 68,
                fontWeight: 700,
                color: COLORS.teal,
                opacity: summary,
              }}
            >
              性格も、声も、自分でつくれる。
            </div>
            <div
              style={{
                fontSize: SIZES.midLine,
                color: COLORS.text,
                opacity: summary,
              }}
            >
              アプリでつくって、おもちゃにすぐ反映
            </div>
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
