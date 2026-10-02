"""Generate a deterministic rolling-train sound for the local SFX library."""
import math
import random
import struct
import wave
from pathlib import Path

RATE = 44100
DURATION = 1.75
OUT = Path(__file__).resolve().parents[1] / "public/sfx/train_pass.wav"
rng = random.Random(12012)
samples = bytearray()
low_noise = 0.0
for i in range(round(RATE * DURATION)):
    t = i / RATE
    fade = min(1.0, t / 0.12, (DURATION - t) / 0.35)
    low_noise = low_noise * 0.988 + rng.uniform(-1, 1) * 0.012
    rumble = 0.24 * math.sin(2 * math.pi * 74 * t) + 0.13 * math.sin(2 * math.pi * 113 * t)
    hiss = 0.12 * rng.uniform(-1, 1) + 0.35 * low_noise
    wheel_phase = t % 0.115
    clack = math.exp(-wheel_phase * 55) * (
        0.19 * math.sin(2 * math.pi * 570 * wheel_phase)
        + 0.11 * math.sin(2 * math.pi * 970 * wheel_phase)
    )
    value = max(-1.0, min(1.0, fade * (rumble + hiss + clack)))
    samples += struct.pack("<h", round(value * 32767))

with wave.open(str(OUT), "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(RATE)
    wav.writeframes(samples)
print(OUT)
