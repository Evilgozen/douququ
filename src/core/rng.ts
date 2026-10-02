/** 确定性随机数（mulberry32）：同 seed 同操作序列 → 同结果 */
export class RNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
