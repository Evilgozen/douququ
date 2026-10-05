import assert from 'node:assert/strict';
import { decodeVolcV3Response, synthesizeVolcV3 } from '../src/tts/volcV3.ts';
import { parseWav } from '../src/audio/mixer.ts';

const pcm = Buffer.alloc(48000);
const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const words = [{ word: '猫', startTime: 0.1, endTime: 0.3 }];
const body = 'event: 352\n' + frame({ code: 0, data: pcm.subarray(0, 1001).toString('base64') }) +
  frame({ code: 0, data: pcm.subarray(1001).toString('base64'), sentence: { words } }) +
  frame({ code: 0, sentence: { words } }) + frame({ code: 20000000 });
const result = decodeVolcV3Response(body);
const wav = parseWav(result.wav.buffer.slice(result.wav.byteOffset, result.wav.byteOffset + result.wav.byteLength) as ArrayBuffer);
assert.equal(wav.sampleRate, 24000); assert.equal(wav.samples.length, 24000);
assert.equal(result.durMs, 1000); assert.deepEqual(result.words, words);
assert.throws(() => decodeVolcV3Response(frame({ code: 0, data: pcm.toString('base64') })), /未正常结束/);
assert.throws(() => decodeVolcV3Response(frame({ code: 45000000 })), /45000000/);
assert.throws(() => decodeVolcV3Response(frame({ code: 20000000 })), /为空/);

const previousKey = process.env.VOLC_TTS_API_KEY;
const previousFetch = globalThis.fetch;
try {
  process.env.VOLC_TTS_API_KEY = 'local-test-placeholder';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse');
    assert.equal((init?.headers as Record<string, string>)['X-Api-Resource-Id'], 'seed-tts-2.0');
    const request = JSON.parse(init?.body as string);
    assert.equal(request.req_params.audio_params.format, 'pcm');
    assert.equal(request.req_params.audio_params.speech_rate, -20);
    assert.equal(request.req_params.audio_params.enable_subtitle, true);
    return new Response(body, { status: 200 });
  };
  assert.equal((await synthesizeVolcV3('测试', { voice: 'test-voice', speed: 0.8 })).durMs, 1000);
} finally {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.VOLC_TTS_API_KEY;
  else process.env.VOLC_TTS_API_KEY = previousKey;
}
console.log('豆包 v3 检查通过：请求配置、流式拼接、时长、时间戳、截断与错误处理（未调用付费接口）。');
