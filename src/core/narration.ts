import type { Episode } from './types';

/** 旧配音清单不能继续给改写后的剧本配音。 */
export function narrationMatches(ep: Episode, lines: Array<{ text?: string; t: number }>): boolean {
  return (ep.captions ?? []).every((caption) =>
    lines.some((line) => line.text === caption.text && Math.abs(line.t - caption.t) < 0.05),
  );
}
