/** 浏览器端录制：MediaRecorder 实时录制 canvas → webm 下载。 */
export interface RecordResult {
  blob: Blob;
  ext: string;
}

export function pickMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

export function recordCanvas(
  canvas: HTMLCanvasElement,
  isDone: () => boolean,
  onTick?: (elapsed: number) => void,
): Promise<RecordResult> {
  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(30);
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 14_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onerror = () => reject(new Error('MediaRecorder 录制失败'));
    rec.onstop = () => {
      const ext = mimeType.includes('vp9') ? 'webm' : 'webm';
      resolve({ blob: new Blob(chunks, { type: mimeType }), ext });
    };
    rec.start(500);

    const t0 = performance.now();
    const poll = () => {
      const elapsed = (performance.now() - t0) / 1000;
      onTick?.(elapsed);
      // 结束后再录 0.8s 收尾帧
      if (isDone()) {
        setTimeout(() => {
          if (rec.state !== 'inactive') rec.stop();
        }, 800);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
