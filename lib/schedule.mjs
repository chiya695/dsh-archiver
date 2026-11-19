/**
 * lib/schedule.mjs —— 自动归档的"到点了没"判定（纯函数，方便单测）
 * ============================================================================
 * 两种节拍可以同时开：
 *   · everyHours：距离上次运行（任何来源）超过 N 小时就跑；
 *   · dailyAt：每天本地时间 HH:MM 之后跑一次，靠 state.lastDailySlot 记住今天跑过。
 * minGapMinutes 是最后一道防抖：刚跑完（不论手动还是自动）不会立刻再跑。
 * ============================================================================
 */

export function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * @param {object} o
 * @param {object} o.cfg  规范化后的配置
 * @param {object} o.state state.json 内容
 * @param {number} [o.now] 毫秒时间戳
 * @returns {string} 空串 = 不用跑；否则是触发原因
 */
export function autoReason({ cfg, state, now = Date.now() }) {
  if (!cfg?.enabled) return ''
  const auto = cfg.auto || {}
  const st = state || {}

  const lastRun = Date.parse(st.lastRunAt || '') || 0
  const gapMs = Math.max(0, Number(auto.minGapMinutes) || 0) * 60_000
  if (lastRun && gapMs > 0 && now - lastRun < gapMs) return ''

  if (auto.dailyAt && /^\d{2}:\d{2}$/u.test(auto.dailyAt)) {
    const [h, m] = auto.dailyAt.split(':').map(Number)
    const due = new Date(now)
    due.setHours(h, m, 0, 0)
    const slot = `${localDateKey(new Date(now))} ${auto.dailyAt}`
    if (now >= due.getTime() && st.lastDailySlot !== slot) return `daily:${auto.dailyAt}`
  }

  const everyH = Number(auto.everyHours) || 0
  if (everyH > 0) {
    const gap = everyH * 3_600_000
    if (!lastRun || now - lastRun >= gap) return `every:${everyH}h`
  }

  return ''
}

/**
 * 下一次自动归档的预计时间（面板上给人看的）。
 * @param {object} o
 * @param {object} o.cfg
 * @param {object} o.state
 * @param {number} [o.now]
 * @returns {string} ISO 时间；空串 = 当前设置下不会再自动跑
 */
export function nextRunAt({ cfg, state, now = Date.now() }) {
  if (!cfg?.enabled) return ''
  const auto = cfg.auto || {}
  const lastRun = Date.parse(state?.lastRunAt || '') || 0
  const gapMs = Math.max(0, Number(auto.minGapMinutes) || 0) * 60_000
  const floor = lastRun && gapMs > 0 ? lastRun + gapMs : now
  const candidates = []

  const everyH = Number(auto.everyHours) || 0
  if (everyH > 0) {
    const gap = everyH * 3_600_000
    candidates.push(lastRun ? Math.max(floor, lastRun + gap) : now)
  }

  if (auto.dailyAt && /^\d{2}:\d{2}$/u.test(auto.dailyAt)) {
    const [h, m] = auto.dailyAt.split(':').map(Number)
    const slotToday = `${localDateKey(new Date(now))} ${auto.dailyAt}`
    const due = new Date(now)
    due.setHours(h, m, 0, 0)
    let at = due.getTime()
    if (state?.lastDailySlot === slotToday) at += 24 * 3_600_000
    candidates.push(Math.max(floor, at))
  }

  if (!candidates.length) return ''
  return new Date(Math.min(...candidates)).toISOString()
}
