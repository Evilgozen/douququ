/** 浏览器预览用：WebAudio 即时播放 Lua 触发的音效（出片走 CLI 混音，这里只是试听反馈） */
export class BrowserSfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private clips = new Map<string, { source: AudioBufferSourceNode; start: number; offset: number; rate: number; name: string }>();

  /** 动作原声按模拟片段偏移播放：暂停、倍速、重播均校准到同一时间。 */
  syncClip(id: string, name: string, offset: number | null, vol: number, rate: number, playing: boolean): void {
    const old = this.clips.get(id);
    const buffer = this.buffers.get(name);
    if (!this.ctx || !buffer) return;
    const stop = () => { if (old) { old.source.stop(); this.clips.delete(id); } };
    if (!playing || offset === null || offset >= buffer.duration) { stop(); return; }
    const playbackRate = Math.max(0.1, rate);
    const position = old ? old.offset + (this.ctx.currentTime - old.start) * old.rate : -1;
    if (old && old.name === name && Math.abs(old.rate - playbackRate) < 0.001 && Math.abs(position - offset) < 0.12) return;
    stop();
    void this.ctx.resume();
    const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    source.buffer = buffer; source.playbackRate.value = playbackRate;
    gain.gain.value = Math.max(0, Math.min(1.5, vol));
    source.connect(gain).connect(this.ctx.destination);
    source.start(0, Math.max(0, offset));
    this.clips.set(id, { source, start: this.ctx.currentTime, offset, rate: playbackRate, name });
  }

  stopClips(): void {
    for (const clip of this.clips.values()) clip.source.stop();
    this.clips.clear();
  }

  async preload(manifest: Record<string, string>): Promise<void> {
    this.stopClips();
    if (this.ctx) void this.ctx.close();
    this.buffers.clear();
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
