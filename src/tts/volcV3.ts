/** 豆包语音合成 2.0，HTTP SSE；PCM 拼接后包装为单个 WAV。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VOLC_V3_RESOURCE = 'seed-tts-2.0';
export const VOLC_V3_VOICE = 'zh_female_vv_uranus_bigtts';
export const VOLC_V3_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
export interface WordTimestamp { word: string; startTime: number; endTime: number }
export interface VolcV3Result { wav: Buffer; durMs: number; words: WordTimestamp[] }

function readKey(): string {
  const env = process.env.VOLC_TTS_API_KEY?.trim();
  if (env) return env;
  const akskPath = path.resolve(process.cwd(), '.aksk');
  if (fs.existsSync(akskPath)) {
    const entry = fs.readFileSync(akskPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('VOLC_TTS_API_KEY='));
    const value = entry?.slice('VOLC_TTS_API_KEY='.length).trim();
    if (value && !/\s/.test(value)) return value;
  }
  const file = path.resolve(process.cwd(), '.volc-tts-key');
  const key = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!key || /\s/.test(key)) throw new Error('缺少豆包语音 API Key：在项目根目录 .aksk 新增 VOLC_TTS_API_KEY=密钥，或设置同名环境变量；也支持 .volc-tts-key 单行文件（不要使用方舟聊天模型的 Key）。');
  return key;
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error('豆包返回的 16-bit PCM 数据为空或不完整');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

export function decodeVolcV3Response(body: string, sampleRate = 24000): VolcV3Result {
  const chunks: Buffer[] = [];
  const words: WordTimestamp[] = [];
  let finished = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('event:') || line.startsWith(':') || line.startsWith('id:')) continue;
    const json = line.startsWith('data:') ? line.slice(5).trim() : line;
    let frame: { code: number; data?: string | null; sentence?: { words?: WordTimestamp[] } };
    try { frame = JSON.parse(json); } catch { throw new Error('豆包语音响应不是有效的流式 JSON'); }
    // 不回显服务端 message，避免鉴权错误夹带凭证。
    if (frame.code !== 0 && frame.code !== 20000000) throw new Error(`豆包语音合成 2.0 失败（code=${frame.code}，请检查资源开通、余额和音色权限）`);
    if (frame.code === 20000000) finished = true;
    if (frame.data) chunks.push(Buffer.from(frame.data, 'base64'));
    for (const word of frame.sentence?.words ?? []) {
      if (typeof word.word === 'string' && Number.isFinite(word.startTime) && Number.isFinite(word.endTime) && word.startTime >= 0 && word.endTime >= word.startTime) words.push(word);
    }
  }
  if (!finished) throw new Error('豆包语音流未正常结束，不缓存可能被截断的音频');
  const pcm = Buffer.concat(chunks);
  const uniqueWords = [...new Map(words.map((w) => [`${w.startTime}|${w.endTime}|${w.word}`, w])).values()].sort((a, b) => a.startTime - b.startTime);
  return { wav: pcmToWav(pcm, sampleRate), durMs: pcm.length / 2 / sampleRate * 1000, words: uniqueWords };
}

export async function synthesizeVolcV3(text: string, cfg: { voice: string; speed: number }): Promise<VolcV3Result> {
  const key = readKey();
  const sampleRate = 24000;
  const res = await fetch(VOLC_V3_ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Api-Key': key, 'X-Api-Resource-Id': VOLC_V3_RESOURCE,
      'X-Api-Request-Id': crypto.randomUUID(), 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ req_params: {
      text, speaker: cfg.voice,
      audio_params: { format: 'pcm', sample_rate: sampleRate, speech_rate: Math.round((Math.min(2, Math.max(0.5, cfg.speed)) - 1) * 100), enable_subtitle: true },
    } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`豆包语音合成 2.0 HTTP ${res.status}（请检查豆包语音 API Key、资源权限和余额）`);
  return decodeVolcV3Response(await res.text(), sampleRate);
}
