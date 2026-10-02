#!/usr/bin/env python3
"""程序化合成 BGM 循环垫乐（CC0 等效——完全程序生成，无版权问题）。
A 小调 4 和弦进行（Am-F-C-G），pad + 贝斯 + 轻鼓，120 秒，44.1kHz 16bit mono。
用法：python3 scripts/gen_bgm.py [输出路径，默认 public/bgm/chill-loop.wav]
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 120.0
BPM = 100.0
BEAT = 60.0 / BPM  # 0.6s

# 和弦进行：每段 7.5s（120s / 16 段），[贝斯根音, 和弦音列表]
CHORDS = [
    (55.00, [220.00, 261.63, 329.63]),   # Am
    (43.65, [174.61, 220.00, 261.63]),   # F
    (65.41, [261.63, 329.63, 392.00]),   # C
    (49.00, [196.00, 246.94, 293.66]),   # G
]
SEG = DUR / (len(CHORDS) * 4)  # 每和弦重复 4 轮


def pad(f, t, detune=0.002):
    """轻微失谐的双正弦，做出宽 pad 感"""
    return np.sin(2 * np.pi * f * (1 - detune) * t) + np.sin(2 * np.pi * f * (1 + detune) * t)


def envelope(n, attack, release):
    e = np.ones(n)
    a = min(int(attack * SR), n // 2)
    r = min(int(release * SR), n // 2)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] *= np.linspace(1, 0, r)
    return e


def kick(duration=0.09):
    t = np.linspace(0, duration, int(duration * SR), False)
    f = np.linspace(95, 40, len(t))
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 28)


def shaker(duration=0.05):
    n = int(duration * SR)
    noise = np.random.default_rng(7).standard_normal(n)
    # 简易低通：滑动平均
    kernel = np.ones(24) / 24
    return np.convolve(noise, kernel, mode="same") * np.exp(-np.linspace(0, 6, n))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "public/bgm/chill-loop.wav"
    total = int(DUR * SR)
    mix = np.zeros(total)
    t_all = np.arange(total) / SR

    # 和弦 pad + 贝斯
    for rep in range(4):
        for ci, (bass, chord) in enumerate(CHORDS):
            start = int((rep * len(CHORDS) + ci) * SEG * SR)
            n = int(SEG * SR)
            seg_t = np.arange(n) / SR
            seg = np.zeros(n)
            for f in chord:
                seg += pad(f, seg_t)
            seg += 1.6 * np.sin(2 * np.pi * bass * seg_t)
            seg *= envelope(n, attack=0.9, release=1.1)
            mix[start:start + n] += seg * 0.22

    # 轻鼓：kick 每拍，shaker 反拍
    kicks = np.arange(0, DUR, BEAT)
    for k in kicks:
        s = int(k * SR)
        mix[s:s + len(kick())] += kick() * 0.5
    shakers = np.arange(BEAT / 2, DUR, BEAT)
    for k in shakers:
        s = int(k * SR)
        mix[s:s + len(shaker())] += shaker() * 0.16

    # 全局淡入淡出 + 归一
    mix[: int(1.5 * SR)] *= np.linspace(0, 1, int(1.5 * SR))
    mix[-int(2.0 * SR):] *= np.linspace(1, 0, int(2.0 * SR))
    mix *= 0.55 / max(1e-9, np.abs(mix).max())

    pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"BGM 已生成：{out}（{DUR:.0f}s，{os.path.getsize(out)//1024} KB）" if (os := __import__("os")) else "")


if __name__ == "__main__":
    main()
