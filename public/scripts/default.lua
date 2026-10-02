-- 默认演出脚本：把「音效 / 碰撞 / 状态转移」绑定到引擎事件上。
-- 可用事件：collision / wall / attack / crit / death / twist / phase
-- 可用 API：
--   engine.sfx(name, vol, rate)  播放音效（name 见 public/sfx/index.json）
--   engine.shake(n)              叠加震屏
--   engine.flash()               白闪
--   engine.slowmo(sec)           慢放
--   engine.banner(text)          中央大字横幅
--   engine.caption(text, gold)   底部字幕
--   engine.rand()                确定性随机数
--   engine.hp(id)                单位血量百分比 0..1
--   engine.get/set(id, key, v)   单位自定义状态（状态转移用）
--   engine.name(id)              单位名
--   engine.log(text)             控制台日志

-- ============ 碰撞：音效 + 震屏 + 连撞状态转移 ============
local lastHitAt = 0
local bumpCount = {}

engine.on("collision", function(e)
  -- 节流：80ms 内的连撞只响最重的一声
  if e.t - lastHitAt < 0.08 then return end
  lastHitAt = e.t

  -- 撞击强度 0..1（由相对速度决定）
  local p = math.min(1, e.speed / 520)
  if p < 0.10 then return end

  if p > 0.55 then
    engine.sfx("collide_heavy", 0.35 + 0.45 * p)
    engine.shake(2 + 7 * p)
  else
    engine.sfx("collide_light", 0.25 + 0.35 * p)
    engine.shake(1 + 3 * p)
  end

  -- 状态转移：双方各自计连撞数，攒满 5 次标记"上头"
  for _, id in ipairs({ e.a, e.b }) do
    bumpCount[id] = (bumpCount[id] or 0) + 1
    if bumpCount[id] == 5 and engine.get(id, "hyped") == 0 then
      engine.set(id, "hyped", 1)
      engine.caption(engine.name(id) .. " 撞上头了！", true)
      engine.sfx("bell", 0.5)
    end
  end
end)

-- ============ 撞墙：速度够快才响 ============
engine.on("wall", function(e)
  if e.speed > 240 then
    engine.sfx("wall", 0.3)
    engine.shake(3)
  end
end)

-- ============ 地图机关：弹板 / 加速带 ============
engine.on("bumper", function(e)
  engine.sfx("bumper", 0.55, 0.9 + 0.2 * engine.rand())
  engine.shake(6)
end)

engine.on("boost", function(e)
  engine.sfx("boost", 0.4, 1.1 + 0.2 * engine.rand())
end)

-- ============ 飞行道具出手：破空声 ============
engine.on("projectile", function(e)
  engine.sfx("boost", 0.45, 0.7)
end)

engine.on("train_depart", function(e)
  engine.sfx("train_pass", 0.9)
end)

-- ============ 攻击 / 暴击 / 击倒 ============
engine.on("attack", function(e)
  if e.skill == "列车撞击" then
    if engine.hp(e.victim) > 0 then engine.sfx("ko", 0.9) end
    return
  end
  if e.skill == "蓄力突刺" then
    engine.sfx("hit_heavy", 0.95, 1.0)
    engine.shake(8)
    return
  end
  -- 普通命中的肉感（Lua 5.4 无 math.log10，用 math.log(x,10)）
  local p = math.min(1, math.log(e.dmg + 1, 10) / 6)
  engine.sfx(e.mult >= 3 and "hit_heavy" or "hit_light", 0.35 + 0.4 * p, 0.95 + 0.2 * engine.rand())
end)

engine.on("crit", function(e)
  engine.sfx("hit_crit", 0.9)
  engine.shake(10)
end)

-- 护盾吸收：金属重音；盾碎时额外加钟声和震屏
engine.on("block", function(e)
  engine.sfx("collide_heavy", 0.7, 0.88 + 0.08 * engine.rand())
  engine.shake(e.broken and 12 or 6)
  if e.broken then
    engine.sfx("impact_wood", 0.75, 0.82)
    engine.sfx("bell", 0.55, 0.75)
  end
end)

engine.on("death", function(e)
  engine.sfx("ko", 1)
  engine.slowmo(0.8)
  engine.shake(16)
end)

-- ============ 反转：钟声 + 白闪 ============
engine.on("twist", function(e)
  engine.sfx("twist", 0.85)
  engine.flash()
end)

-- ============ 奶娃机制：毒气 / 骑车 / 摔倒 ============
engine.on("gas", function(e)
  -- 毒气出云很密，低音量短促"噗"，不跟攻击音打架
  engine.sfx("collide_light", 0.12, 0.7)
end)

engine.on("bike", function(e)
  engine.sfx("boost", 0.55, 1.25)
  engine.sfx("bell", 0.5)
end)

engine.on("crash", function(e)
  engine.sfx("hit_heavy", 0.9, 0.8)
  engine.shake(14)
end)

-- ============ 外卖轮盘：派单破空声 ============
engine.on("takeout", function(e)
  engine.sfx("boost", 0.4, 1.6)
end)

-- ============ 阶段 ============
engine.on("phase", function(e)
  if e.name == "fight" then
    engine.sfx("bell", 0.6)
  end
end)
