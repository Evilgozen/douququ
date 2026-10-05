/**
 * 音效混音器：把模拟产出的 SFX 事件与解说配音按时间轴混成一条 44.1kHz WAV。
 * 仅支持 16-bit PCM WAV；浏览器预览走 WebAudio，不经过这里。
 */
export interface WavAudio {
  sampleRate: number;
  samples: Float32Array; // mono, -1..1
}

export function parseWav(buffer: ArrayBuffer): WavAudio {
  const view = new DataView(buffer);
  const str = (off: number, len: number) => String.fromCharCode(...Array.from(new Uint8Array(buffer, off, len)));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是 WAV 文件');
  let off = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buffer.byteLength) {
    const id = str(off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(size, buffer.byteLength - dataOff);
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('WAV 缺少 data 块');
  if (bits !== 16) throw new Error(`仅支持 16-bit PCM，遇到 ${bits}-bit`);
  const n = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) v += view.getInt16(dataOff + (i * channels + c) * 2, true) / 32768;
    samples[i] = v / channels;
  }
  return { sampleRate, samples };
}

export interface MixedSfxEvent {
  name: string;
  /** 视频时间轴（秒） */
  t: number;
  vol: number;
  rate: number;
  /** 演出取消或进入结算时截断该片段（输出时间轴秒数）。 */
  durationSec?: number;
}

export interface NarrationClip {
  /** 视频时间轴（秒） */
  t: number;
  audio: WavAudio;
  vol: number;
}

function place(dst: Float32Array, src: Float32Array, startFrame: number, step: number, vol: number): void {
  // step 是每个输出采样对应的输入采样数。按输出取样，避免升采样空洞和降采样累加。
  const frames = Math.ceil(src.length / step);
  for (let i = Math.max(0, -startFrame); i < frames && startFrame + i < dst.length; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const fraction = pos - left;
    const value = src[left] + ((src[Math.min(left + 1, src.length - 1)] ?? 0) - src[left]) * fraction;
    dst[startFrame + i] += value * vol;
  }
}

/** 音效层：按事件调度（支持变速） */
export function mixSfxFloat(
  events: MixedSfxEvent[],
  lib: Map<string, WavAudio>,
  durationSec: number,
  masterVol = 1,
  sampleRate = 44100,
): Float32Array {
  const out = new Float32Array(Math.ceil(durationSec * sampleRate));
  for (const ev of events) {
    const w = lib.get(ev.name);
    if (!w) {
      console.warn(`[mixer] 未登记的音效：${ev.name}`);
      continue;
    }
    const rate = Math.max(0.05, ev.rate);
    const samples = ev.durationSec === undefined ? w.samples : w.samples.subarray(0, Math.max(0, Math.ceil(ev.durationSec * rate * w.sampleRate)));
    place(out, samples, Math.floor(ev.t * sampleRate), (w.sampleRate / sampleRate) * rate, ev.vol * masterVol);
  }
  return out;
}

/** 配音层：整段 clip 按起点放置 */
export function mixClipsFloat(clips: NarrationClip[], durationSec: number, sampleRate = 44100): Float32Array {
  const out = new Float32Array(Math.ceil(durationSec * sampleRate));
  for (const c of clips) {
    const step = c.audio.sampleRate / sampleRate;
    place(out, c.audio.samples, Math.floor(c.t * sampleRate), step, c.vol);
  }
  return out;
}

export interface BgmLayer {
  audio: WavAudio;
  /** 基础音量 */
  vol: number;
  /** 解说期间压到的音量倍数（0..1） */
  duckTo: number;
}

/** BGM 层：循环铺底，解说时间窗内平滑压音量（ducking），进出各 0.25s 线性 */
export function mixBgmFloat(
  bgm: BgmLayer,
  durationSec: number,
  duckWindows: Array<{ t: number; dur: number }>,
  sampleRate = 44100,
): Float32Array {
  const n = Math.ceil(durationSec * sampleRate);
  const out = new Float32Array(n);
  const step = bgm.audio.sampleRate / sampleRate;
  const srcLen = bgm.audio.samples.length;
  if (srcLen === 0) return out;

  const ramp = Math.floor(0.25 * sampleRate);
  const ducked = bgm.vol * bgm.duckTo;
  for (let i = 0; i < n; i++) {
    let g = bgm.vol;
    for (const w of duckWindows) {
      const s = Math.max(0, Math.floor(w.t * sampleRate) - ramp);
      const e = Math.min(n, Math.ceil((w.t + w.dur + 0.3) * sampleRate));
      if (i < s || i > e) continue;
      const startFull = s + ramp;
      const endFull = Math.max(startFull, e - ramp);
      let gv: number;
      if (i < startFull) gv = bgm.vol + (ducked - bgm.vol) * ((i - s) / Math.max(1, ramp));
      else if (i > endFull) gv = ducked + (bgm.vol - ducked) * ((i - endFull) / Math.max(1, e - endFull));
      else gv = ducked;
      g = Math.min(g, gv);
    }
    const src = Math.floor((i * step) % srcLen);
    out[i] = bgm.audio.samples[src] * g;
  }
  return out;
}

/** 多层求和 + 软限幅 + 编码 16-bit WAV。
 *  超过 0.98 的瞬态尖峰用 tanh 软削（只压过冲，不整体缩放，避免人声被连带拉低） */
export function encodeMix(layers: Float32Array[], sampleRate = 44100): Uint8Array {
  const n = Math.max(...layers.map((l) => l.length));
  const out = new Float32Array(n);
  let peak = 0;
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      out[i] += layer[i];
      const a = Math.abs(out[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0.98) {
    console.log(`[mixer] 峰值 ${peak.toFixed(2)} 过载，软限幅削峰（其余内容不动）`);
    const KNEE = 0.7;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(out[i]);
      if (a > KNEE) {
        const compressed = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
        out[i] = Math.sign(out[i]) * compressed;
      }
    }
  }
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return bytes;
}
