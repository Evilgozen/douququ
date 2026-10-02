/**
 * 火山引擎（豆包语音）TTS 客户端
 * 文档：https://www.volcengine.com/docs/6561/1105162（鉴权） / 6561/79820（HTTP 非流式）
 * - Endpoint: POST https://openspeech.bytedance.com/api/v1/tts
 * - 鉴权：Authorization: "Bearer;<token>"（分号不是空格）
 *   实测（2026-09）：.aksk 火山段落的 AK 就是访问令牌，直接当 token 用即可；
 *   AK/SK 的 JWT 方案在该账号下返回 3001，不可用
 * - 返回 data 为 base64 音频
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface VolcCfg {
  voice: string;
  speed: number;
  /** cluster，经典/大模型音色默认 volcano_tts */
  cluster: string;
  /** 音量 0.1..2，默认 1 */
  vol?: number;
}

export interface VolcResult {
  wav: Buffer;
}

function readVolcCreds(): { token: string; appid: string; cluster?: string } {
  const p = path.resolve(process.cwd(), '.aksk');
  if (!fs.existsSync(p)) throw new Error('缺少 .aksk 文件');
  const lines = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const marker = lines.findIndex((l) => l.includes('火山'));
  if (marker === -1 || marker + 2 >= lines.length) {
    throw new Error('.aksk 里没有火山段落（需要「火山」标记行 + 访问令牌行 + AppID 行）');
  }
  const token = lines[marker + 1];
  // 第 3 行：数字 AppID；第 4 行（可选）：cluster
  const rest = lines.slice(marker + 2);
  const appid = rest.find((l) => /^\d+$/.test(l));
  const cluster = rest.find((l) => !/^\d+$/.test(l) && l !== token);
  if (!appid) {
    throw new Error('缺少火山 AppID：在访问令牌行下面加一行数字 AppID（控制台 → 语音技术 → 应用管理）');
  }
  return { token, appid, cluster };
}

export async function synthesizeVolc(text: string, cfg: VolcCfg): Promise<VolcResult> {
  const { token, appid, cluster } = readVolcCreds();
  const body = {
    app: { appid, token: 'access_token', cluster: cfg.cluster ?? cluster ?? 'volcano_tts' },
    user: { uid: 'douququ' },
    audio: {
      voice_type: cfg.voice,
      encoding: 'wav',
      speed_ratio: Math.min(2, Math.max(0.2, cfg.speed)),
      // 注意：经典 volcano_tts HTTP 接口不支持 volume_ratio（3031 unmapped key），
      // 音量在混音阶段按 manifest 里的 vol 应用（见 render.ts / mixer NarrationClip）
      pitch_ratio: 1,
    },
    request: { reqid: crypto.randomUUID(), text, text_type: 'plain', operation: 'query' },
  };
  const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer;${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json()) as { data?: string; message?: string; code?: number };
  if (!json.data) {
    throw new Error(`火山 TTS 失败（code=${json.code ?? res.status}）：${json.message ?? '未知错误'}`);
  }
  return { wav: Buffer.from(json.data, 'base64') };
}
