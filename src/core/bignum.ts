/** 中文大数格式化：数值差异/倍数冲击的可读性保障 */
function trim1(n: number): string {
  const s = n >= 100 ? Math.round(n).toString() : n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 88 → "88"，54200 → "5.4万"，123456789 → "1.2亿"，5e12 → "50000万亿" */
export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${trim1(abs / 1e12)}万亿`;
  if (abs >= 1e8) return `${sign}${trim1(abs / 1e8)}亿`;
  if (abs >= 1e4) return `${sign}${trim1(abs / 1e4)}万`;
  return `${sign}${Math.round(abs)}`;
}

/** 倍率徽章：2 → "x2"，2.5 → "x2.5" */
export function fmtMult(m: number): string {
  return `x${trim1(m)}`;
}
