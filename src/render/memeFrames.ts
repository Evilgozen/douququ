import type { MemeSkillDef } from '../core/types';

export function memeFramePath(skill: MemeSkillDef, index: number): string {
  return `${skill.framePrefix}${String(Math.min(skill.frameCount - 1, Math.max(0, index))).padStart(3, '0')}.png`;
}

export function memeFrameAt(skill: MemeSkillDef, elapsed: number): string {
  return memeFramePath(skill, Math.floor((elapsed + 1e-9) * skill.fps));
}
