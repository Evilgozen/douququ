import assert from 'node:assert/strict';
import { mixClipsFloat, mixSfxFloat, encodeMix, parseWav } from '../src/audio/mixer.ts';

// 一秒的常量信号应保留时长、幅度，升采样后不应出现空洞。
for (const sampleRate of [16000, 24000, 44100, 48000]) {
  const audio = { sampleRate, samples: new Float32Array(sampleRate).fill(0.25) };
  const decoded = parseWav(encodeMix([audio.samples], sampleRate).buffer as ArrayBuffer);
  assert.equal(decoded.samples.length / decoded.sampleRate, 1);
  const mixed = mixClipsFloat([{ t: 0.2, audio: decoded, vol: 1 }], 1.5);
  assert.equal(mixed[8819], 0);
  assert.ok(Math.abs(mixed[8820] - 0.25) < 0.0001);
  assert.ok(Math.abs(mixed[52919] - 0.25) < 0.0001);
  assert.equal(mixed[52920], 0);
  assert.ok(mixed.slice(8820, 52920).every((v) => Math.abs(v - 0.25) < 0.0001));

  // 两倍速应缩短至半秒，不能拉长或增加音量。
  const sfx = mixSfxFloat([{ name: 'hit', t: 0, vol: 1, rate: 2 }], new Map([['hit', audio]]), 1);
  assert.equal(sfx[22049], 0.25);
  assert.equal(sfx[22050], 0);
}

// 校验重采样保留音高，而不是只匹配音频长度。
for (const sampleRate of [24000, 48000]) {
  const audio = { sampleRate, samples: Float32Array.from({ length: sampleRate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / sampleRate)) };
  const mixed = mixClipsFloat([{ t: 0, audio, vol: 1 }], 1);
  let crossings = 0;
  for (let i = 1; i < mixed.length; i++) if (mixed[i - 1] <= 0 && mixed[i] > 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 1, `${sampleRate}Hz: ${crossings} crossings`);
}
console.log('音频检查通过：采样率、时长、幅度、音高及 SFX 倍速。');
