/**
 * MiniMax T2A (speech-to-audio) 客户端
 * 文档：https://platform.minimax.cn/docs/api-reference/speech-t2a-http
 * 认证：Authorization: Bearer <api key>（.aksk 文件第一行）
 * 返回 data.audio 为 hex 编码音频；请求 wav 格式可直接喂给混音器（44.1kHz 16bit mono）
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TtsVoiceCfg {
  model: string;
  voice: string;
  speed: number;
  pitch: number;
  vol: number;
  emotion?: string;
}

export const DEFAULT_VOICE: TtsVoiceCfg = {
  model: 'speech-2.8-hd',
  voice: 'male-qn-qingse', // 青涩青年，解说底子好；可在剧本 narration.voice 里换
  speed: 0.95,
  pitch: 0,
  vol: 1,
};

export interface TtsResult {
  wav: Buffer;
  /** 音频时长（毫秒） */
  durMs: number;
}

function readApiKey(): string {
  const p = path.resolve(process.cwd(), '.aksk');
  if (!fs.existsSync(p)) {
    throw new Error('缺少 .aksk 文件（项目根目录，第一行放 MiniMax API Key，形如 sk-api-xxx）');
  }
  const key = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim();
  if (!key) throw new Error('.aksk 文件为空');
  return key;
}

export async function synthesize(text: string, cfg: TtsVoiceCfg = DEFAULT_VOICE): Promise<TtsResult> {
  const key = readApiKey();
  const body: Record<string, unknown> = {
    model: cfg.model,
    text,
    stream: false,
    voice_setting: {
      voice_id: cfg.voice,
      speed: Math.min(2, Math.max(0.5, cfg.speed)),
      vol: Math.min(10, Math.max(0.1, cfg.vol)),
      pitch: Math.min(12, Math.max(-12, cfg.pitch)),
      ...(cfg.emotion ? { emotion: cfg.emotion } : {}),
    },
    audio_setting: { sample_rate: 44100, format: 'wav', channel: 1 },
    output_format: 'hex',
  };
  const res = await fetch('https://api.minimax.cn/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json()) as {
    data?: { audio?: string };
    extra_info?: { audio_length?: number; usage_characters?: number };
    base_resp?: { status_code: number; status_msg: string };
  };
  const code = json.base_resp?.status_code ?? -1;
  if (code !== 0 || !json.data?.audio) {
    const msg = json.base_resp?.status_msg ?? `HTTP ${res.status}`;
    if (code === 1008) {
      throw new Error('MiniMax 余额不足（1008 insufficient balance）——请到 platform.minimax.cn 充值后重试');
    }
    if (code === 1004) {
      throw new Error('MiniMax 鉴权失败（1004）——检查 .aksk 里的 API Key');
    }
    throw new Error(`MiniMax TTS 失败（${code}）：${msg}`);
  }
  const wav = Buffer.from(json.data.audio, 'hex');
  return { wav, durMs: json.extra_info?.audio_length ?? 0 };
}

export function voiceKey(cfg: TtsVoiceCfg): string {
  return `${cfg.model}|${cfg.voice}|${cfg.speed}|${cfg.pitch}|${cfg.vol}|${cfg.emotion ?? ''}`;
}
