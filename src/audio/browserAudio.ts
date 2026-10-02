/** 浏览器预览用：WebAudio 即时播放 Lua 触发的音效（出片走 CLI 混音，这里只是试听反馈） */
export class BrowserSfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();

  async preload(manifest: Record<string, string>): Promise<void> {
    try {
      this.ctx = new AudioContext();
    } catch {
      return; // 无 AudioContext 时静默降级
    }
    await Promise.all(
      Object.entries(manifest).map(
        ([name, file]) =>
          new Promise<void>((resolve) => {
            fetch('/sfx/' + file)
              .then((r) => r.arrayBuffer())
              .then((ab) => this.ctx!.decodeAudioData(ab))
              .then((buf) => {
                this.buffers.set(name, buf);
                resolve();
              })
              .catch(() => resolve());
          }),
      ),
    );
  }

  play(name: string, vol: number, rate: number): void {
    const buf = this.buffers.get(name);
    if (!this.ctx || !buf) return;
    this.playBuffer(buf, vol, rate);
  }

  playBuffer(buf: AudioBuffer, vol = 1, rate = 1): void {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.1, rate);
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1.5, vol));
    src.connect(gain).connect(this.ctx.destination);
    src.start();
  }

  /** 解码一段音频（wav/mp3 都行，走浏览器解码器） */
  async decode(arrayBuffer: ArrayBuffer): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      return await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      return null;
    }
  }
}
