import fs from 'node:fs';
import path from 'node:path';
import { synthesizeVolcV3, VOLC_V3_VOICE } from '../src/tts/volcV3.ts';

// 只合成一个短句验证账户权限；成功后保存试听及字级时间戳。
try {
  const result = await synthesizeVolcV3('蓄力突刺，命中固定一百六十五。', { voice: VOLC_V3_VOICE, speed: 1 });
  const dir = path.resolve('public/tts/probe-volc-v3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample.wav'), result.wav);
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ durationMs: result.durMs, words: result.words }, null, 2));
  console.log(`豆包语音合成 2.0 验证成功：${(result.durMs / 1000).toFixed(2)}s，${result.words.length} 个字级时间戳；${dir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '豆包语音合成 2.0 验证失败');
  process.exitCode = 1;
}
