/**
 * Lua 脚本层：把「音效 / 碰撞 / 状态转移」作为事件抽象绑定给用户脚本。
 * - 模拟核心每步产出结构化事件（collision/wall/attack/crit/death/twist/phase）
 * - 宿主把事件分发给 Lua：__dispatch(type, payload)
 * - Lua 通过 engine.on(type, fn) 注册处理器，通过 engine.* API 反向驱动演出
 * - 全流程确定性：engine.rand() 走独立的演出 RNG，不消耗物理随机流
 */
import { LuaFactory } from 'wasmoon';
import type { BattleState, GameEvent } from '../core/sim';

export interface EngineHooks {
  sfx(name: string, vol: number, rate: number): void;
  shake(a: number): void;
  flash(): void;
  slowmo(d: number): void;
  banner(text: string): void;
  caption(text: string, gold: boolean): void;
  rand(): number;
  hp(id: string): number;
  get(id: string, key: string): number;
  set(id: string, key: string, value: number): void;
  name(id: string): string;
  log(text: string): void;
}

/** 预置运行时：engine.on 注册器 + 事件分发器（pcall 隔离脚本错误）
 *  注意：JS 桥接表不能存 Lua 函数（wasmoon 代理往返会炸），所以用纯 Lua 表接管 engine，
 *  JS 提供的方法在预置阶段逐个转发绑定。 */
const PRELUDE = `
__handlers = {}
local __js = engine
engine = {}
for _, k in ipairs({"sfx","shake","flash","slowmo","banner","caption","rand","hp","get","set","name","log"}) do
  engine[k] = function(...) return __js[k](...) end
end
function engine.on(name, fn)
  __handlers[name] = __handlers[name] or {}
  table.insert(__handlers[name], fn)
end
function __dispatch(name, e)
  local hs = __handlers[name]
  if not hs then return end
  for i = 1, #hs do
    local ok, err = pcall(hs[i], e)
    if not ok then engine.log("lua error in " .. name .. ": " .. tostring(err)) end
  end
end
`;

type LuaEngine = Awaited<ReturnType<LuaFactory['createEngine']>>;

export class ScriptHost {
  private luaEngine: LuaEngine;

  private constructor(lua: LuaEngine) {
    this.luaEngine = lua;
  }

  static async create(code: string, hooks: EngineHooks, wasmUri?: string): Promise<ScriptHost> {
    const factory = new LuaFactory(wasmUri);
    const lua = await factory.createEngine();
    lua.global.set('engine', {
      // 音效：name 同 public/sfx/index.json 的 key
      sfx: (n: unknown, v: unknown, r: unknown) => hooks.sfx(String(n), Number(v ?? 1), Number(r ?? 1)),
      shake: (a: unknown) => hooks.shake(Number(a ?? 0)),
      flash: () => hooks.flash(),
      slowmo: (d: unknown) => hooks.slowmo(Number(d ?? 0)),
      banner: (t: unknown) => hooks.banner(String(t)),
      caption: (t: unknown, g: unknown) => hooks.caption(String(t), g !== false),
      rand: () => hooks.rand(),
      hp: (id: unknown) => hooks.hp(String(id)),
      get: (id: unknown, k: unknown) => hooks.get(String(id), String(k)),
      set: (id: unknown, k: unknown, v: unknown) => hooks.set(String(id), String(k), Number(v ?? 0)),
      name: (id: unknown) => hooks.name(String(id)),
      log: (t: unknown) => hooks.log(String(t)),
    });
    await lua.doString(PRELUDE);
    await lua.doString(code);
    return new ScriptHost(lua);
  }

  dispatch(ev: GameEvent): void {
    this.luaEngine.global.call('__dispatch', ev.type, ev);
  }
}

/** 把 hooks 绑定到战斗状态（getter 形式：battle 重开后自动指向新状态） */
export function bindHooks(getSt: () => BattleState, opts: { sfxVol: number; onLiveSfx?: (name: string, vol: number, rate: number) => void }): EngineHooks {
  return {
    sfx: (name, vol, rate) => {
      const st = getSt();
      st.sfx.push({ name, t: st.t, vol: Math.min(1.5, Math.max(0, vol)), rate });
      opts.onLiveSfx?.(name, vol, rate);
    },
    shake: (a) => {
      const st = getSt();
      st.shake = Math.min(34, st.shake + Math.max(0, a));
    },
    flash: () => {
      getSt().flash = Math.max(getSt().flash, 0.9);
    },
    slowmo: (d) => {
      const st = getSt();
      st.slowmo = Math.max(st.slowmo, Math.max(0, d));
    },
    banner: (text) => {
      getSt().banners.push({ text, life: 2.2, maxLife: 2.2, color: '#ffd32a' });
    },
    caption: (text, gold) => {
      const st = getSt();
      st.captions.push({ t: st.t, dur: 3, text, gold });
    },
    rand: () => getSt().fxRng.next(),
    hp: (id) => {
      const u = getSt().units.find((x) => x.def.id === id);
      return u ? Math.max(0, u.hp / u.maxHp) : 0;
    },
    get: (id, key) => getSt().units.find((x) => x.def.id === id)?.props[key] ?? 0,
    set: (id, key, value) => {
      const u = getSt().units.find((x) => x.def.id === id);
      if (u) u.props[key] = value;
    },
    name: (id) => getSt().units.find((x) => x.def.id === id)?.name ?? id,
    log: (text) => console.log(`[lua] ${text}`),
  };
}
