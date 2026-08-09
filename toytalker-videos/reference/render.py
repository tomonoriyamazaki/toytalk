import os, math
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
DUR = 15.0
N = int(FPS * DUR)
OUT = "/home/claude/frames"
os.makedirs(OUT, exist_ok=True)

FT = "/usr/share/fonts/opentype/noto/NotoSansCJK-{}.ttc"
def font(size, weight="Regular"):
    return ImageFont.truetype(FT.format(weight), size, index=0)

F_TITLE = font(46, "Bold")
F_STAGE = font(40, "Bold")
F_SUB   = font(28)
F_LANE  = font(30)
F_TEXT  = font(38)
F_PILL  = font(34)
F_CAP   = font(48, "Bold")
F_BIG   = font(72, "Bold")
F_MID   = font(40)

BG      = (15, 18, 32)
CARD    = (26, 30, 48)
CARD_ON = (35, 32, 72)
BORDER  = (42, 47, 72)
PURPLE  = (127, 119, 221)
TXT     = (236, 237, 245)
TXT2    = (154, 160, 184)
P_FILL  = (60, 52, 137);  P_TXT = (206, 203, 246); P_BRD = (83, 74, 183)
T_FILL  = (8, 80, 65);    T_TXT = (159, 225, 203); T_BRD = (29, 158, 117)
PLAY_F  = (29, 158, 117); PLAY_T = (225, 245, 238)

def mix(c, a, base=BG):
    return tuple(int(base[i] + (c[i] - base[i]) * a) for i in range(3))

def ease(t, t0, d=0.35):
    x = (t - t0) / d
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    return 1 - (1 - x) ** 3

FULL = "こんにちは！今日はいい天気だね。何をお話ししようか？"
STT_S = "こんにちは"

def typed(t, t0, t1, s):
    if t < t0: return ""
    n = int(len(s) * min(1.0, (t - t0) / (t1 - t0)))
    return s[:n]

STAGES = [("STT", "音声認識"), ("LLM", "返答生成"), ("TTS", "音声合成"), ("デバイス", "再生")]

def stage_states(t):
    return [ease(t, 0.2), ease(t, 1.8), ease(t, 2.9), ease(t, 3.6)]

def stage_subs(t):
    s = ["待機中", "待機中", "待機中", "待機中"]
    if t >= 0.2: s[0] = "認識中…"
    if t >= 1.75: s[0] = "確定 → 即LLMへ"
    if t >= 1.8: s[1] = "ストリーミング生成中…"
    if t >= 5.7: s[1] = "生成完了"
    if t >= 2.9: s[2] = "文の区切りごとに合成"
    if t >= 3.6: s[3] = "再生中"
    if t >= 10.6: s[3] = "再生完了"
    return s

CAPS = [
    (0.2,  "① 発話をSTTがリアルタイムに文字起こし"),
    (1.8,  "② 確定した瞬間、即LLMへ。返答はストリーミング生成"),
    (2.9,  "③ 文の区切りごとに、生成完了を待たずTTSへ"),
    (3.6,  "④ 最初の音声が届き次第、すぐ再生開始"),
    (5.05, "⑤ 再生の裏で、後続の音声をため込む"),
    (7.0,  "⑥ 生成を待たずに連続再生"),
    (11.0, ""),
]

def caption(t):
    cur, t0 = "", 0
    for ts, c in CAPS:
        if t >= ts: cur, t0 = c, ts
    return cur, t0

def rr(d, box, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def pill(d, x, y, text, a, style, playing=False, t=0):
    if a <= 0.01: return 0
    fill, tc, brd = {"p": (P_FILL, P_TXT, P_BRD), "t": (T_FILL, T_TXT, T_BRD)}[style]
    if playing:
        fill, tc, brd = PLAY_F, PLAY_T, PLAY_F
    w = d.textlength(text, font=F_PILL) + 56
    h = 64
    dy = (1 - a) * 18
    rr(d, (x, y + dy, x + w, y + h + dy), 32, fill=mix(fill, a), outline=mix(brd, a), width=2)
    d.text((x + 28, y + 12 + dy), text, font=F_PILL, fill=mix(tc, a))
    if playing:
        bx = x + w + 18
        for i in range(4):
            hh = 14 + 14 * abs(math.sin(t * 7 + i * 1.1))
            d.rectangle((bx + i * 14, y + 32 - hh / 2, bx + i * 14 + 8, y + 32 + hh / 2), fill=mix(PLAY_F, a))
        return w + 80
    return w + 20

def frame(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    fade = 1.0
    if t > 14.2: fade = max(0.0, 1 - (t - 14.2) / 0.8)
    ga = min(1.0, ease(t, 0.0, 0.4)) * fade

    d.text((80, 46), "応答速度のしくみ — すべてを並行に、待たない設計", font=F_TITLE, fill=mix(TXT, ga))

    on = stage_states(t)
    subs = stage_subs(t)
    sw, gap, sx, sy, sh = 400, 40, 80, 140, 150
    for i, (name, role) in enumerate(STAGES):
        x = sx + i * (sw + gap)
        a = on[i] * fade
        fill = mix(CARD, ga)
        if a > 0: fill = mix(CARD_ON, a) if a > 0.5 else mix(CARD, ga)
        brd = mix(PURPLE, a) if a > 0 else mix(BORDER, ga)
        rr(d, (x, sy, x + sw, sy + sh), 20, fill=fill, outline=brd, width=3)
        d.text((x + 32, sy + 24), name, font=F_STAGE, fill=mix(TXT, ga))
        tl = d.textlength(name, font=F_STAGE)
        d.text((x + 32 + tl + 20, sy + 34), role, font=F_SUB, fill=mix(TXT2, ga))
        d.text((x + 32, sy + 90), subs[i], font=F_SUB, fill=mix(PURPLE if a > 0 else TXT2, max(a, ga * 0.7)))
        if i < 3:
            ax = x + sw + 6
            d.text((ax, sy + sh / 2 - 24), "→", font=F_STAGE, fill=mix(TXT2, ga))

    ly = 360
    lanes = ["ユーザー発話", "LLM ストリーム", "TTS キュー", "デバイス再生"]
    lane_h = 120
    for i, name in enumerate(lanes):
        y = ly + i * lane_h
        d.text((80, y + 20), name, font=F_LANE, fill=mix(TXT2, ga))
        if i < 3:
            d.line((80, y + lane_h - 8, W - 80, y + lane_h - 8), fill=mix(BORDER, ga), width=2)

    lx = 340

    a = ease(t, 0.2) * fade
    if a > 0:
        w = d.textlength("🎤", font=F_PILL)
        pill(d, lx, ly + 8, "● 「こんにちは」", a, "p")
    stt = typed(t, 0.8, 1.7, STT_S)
    if stt:
        d.text((lx + 420, ly + 22), "文字起こし: " + stt, font=F_TEXT, fill=mix(TXT2, fade))

    y2 = ly + lane_h
    llm = typed(t, 1.9, 5.6, FULL)
    if llm:
        d.text((lx, y2 + 24), llm, font=F_TEXT, fill=mix(TXT, fade))
        if t < 5.7 and int(t * 2) % 2 == 0:
            cw = d.textlength(llm, font=F_TEXT)
            d.rectangle((lx + cw + 6, y2 + 26, lx + cw + 12, y2 + 70), fill=mix(PURPLE, fade))

    y3 = ly + lane_h * 2
    cx = lx
    for txt, t0 in [("こんにちは！", 2.9), ("今日はいい天気だね。", 4.35), ("何をお話ししようか？", 5.75)]:
        cx += pill(d, cx, y3 + 12, txt, ease(t, t0) * fade, "p")

    y4 = ly + lane_h * 3
    plays = [("こんにちは！", 3.6, 3.6, 7.0), ("今日はいい天気だね。", 5.05, 7.0, 8.8), ("何をお話ししようか？", 6.45, 8.8, 10.6)]
    cx = lx
    nbuf = 0
    for txt, t0, ps, pe in plays:
        playing = ps <= t < pe
        if t0 <= t < ps: nbuf += 1
        cx += pill(d, cx, y4 + 12, "♪ " + txt, ease(t, t0) * fade, "t", playing=playing, t=t)
    if t >= 3.6 and t < 10.8:
        d.text((cx + 30, y4 + 26), f"バッファ: {nbuf}", font=F_LANE, fill=mix(TXT2, fade))

    cap, ct0 = caption(t)
    if cap:
        ca = ease(t, ct0, 0.3) * fade
        cw = d.textlength(cap, font=F_CAP)
        rr(d, ((W - cw) / 2 - 40, 950, (W + cw) / 2 + 40, 1040), 16, fill=mix(CARD, ca * 0.9))
        d.text(((W - cw) / 2, 966), cap, font=F_CAP, fill=mix(TXT, ca))

    if t >= 11.0:
        ov = min(1.0, ease(t, 11.0, 0.5)) * fade
        d.rectangle((0, 0, W, H), fill=mix(BG, 0.75 * ov, base=None) if False else None)
        overlay = Image.new("RGBA", (W, H), (15, 18, 32, int(215 * ov)))
        img.paste(Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB"), (0, 0))
        d = ImageDraw.Draw(img)
        big = "発話の終わりから、返事が聞こえるまで"
        big2 = "体感レイテンシ 1秒以下"
        bw = d.textlength(big, font=F_MID)
        d.text(((W - bw) / 2, 420), big, font=F_MID, fill=mix(TXT2, ov))
        bw2 = d.textlength(big2, font=F_BIG)
        d.text(((W - bw2) / 2, 500), big2, font=F_BIG, fill=mix((159, 225, 203), ov))
        sub = "認識・生成・合成・再生 — すべてが同時に走っている"
        sw2 = d.textlength(sub, font=F_MID)
        d.text(((W - sw2) / 2, 640), sub, font=F_MID, fill=mix(TXT, ov))

    return img

for i in range(N):
    frame(i / FPS).save(f"{OUT}/{i:04d}.png")
    if i % 90 == 0:
        print("frame", i)
print("done")
