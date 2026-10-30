/**
 * 纯判定：什么时候点「重试」、什么时候等额度、什么时候发下一条指令。
 * 不碰 DOM。页面脚本把界面收成 Observation，再执行返回的 Action。
 */

export const RETRY_TITLES = ["重试", "Retry", "重試"] as const
export const BUSY_TITLES = ["停止", "Stop", "中止", "Interrupt"] as const
export const SCROLL_TITLES = ["滚动到底部", "Scroll to bottom", "滾動到底部"] as const
export const RESET_TITLES = ["重置使用量", "Reset usage", "Reset limit"] as const
export const LIMIT_KEYWORDS = [
  "使用上限",
  "额度已用完",
  "usage limit",
  "codex and work usage",
  "rate limit resets",
] as const
export const DEFAULT_ERROR_KEYWORDS = ["at capacity"]

export type Lang = "zh" | "en"

export interface Config {
  lang: Lang
  intervalSeconds: number
  /** 大于 0 为运行秒数。0 表示不限时，直到手动停止。 */
  durationSeconds: number
  errorKeywords: string[]
  idleSendEnabled: boolean
  idleSendMinutes: number
  scriptLines: string[]
  /** 保留以兼容 macOS 配置。不再因为无错误停止监控。 */
  idleStop: boolean
  limitPause: boolean
  sound: boolean
  noSleep: boolean
}

export type ButtonKind = "retry" | "busy" | "scroll" | "reset" | "other"

export interface ButtonObs {
  label: string
  y: number
  kind: ButtonKind
}

export interface Observation {
  errorYs: number[]
  limitTexts: string[]
  buttons: ButtonObs[]
  /** null = 没有输入框 */
  inputValue: string | null
  userActive: boolean
  /** 墙钟毫秒 */
  now: number
  /** 单调时钟毫秒，空闲计时用，休眠不应把指令立刻发出去 */
  mono: number
}

export interface State {
  clicks: number
  lastErrorAt: number
  cooldownUntil: number
  idleSince: number | null
  idleBaseline: string | null
  idleIdx: number
  postSendUntil: number
  exhausted: boolean
  limitCount: number
  limitStableSince: number
  limitWas: boolean
  limitHintAt: number
  rowCount: number
  rowsStableSince: number
  residualHintAt: number
  userHintAt: number
  lastScrollAt: number
  deadline: number
  running: boolean
}

export type Action =
  | { type: "scroll" }
  | { type: "click"; y: number }
  | { type: "idle-send"; line: string }
  | { type: "stop"; reason: string }
  | { type: "noop" }

export interface StepResult {
  action: Action
  state: State
  logs: string[]
  /** 下一轮建议等待 */
  delayMs: number
}

export function t(lang: Lang, en: string, zh: string): string {
  return lang === "zh" ? zh : en
}

export function defaultConfig(lang: Lang = "en"): Config {
  return {
    lang,
    intervalSeconds: 10,
    durationSeconds: 0,
    errorKeywords: [...DEFAULT_ERROR_KEYWORDS],
    idleSendEnabled: false,
    idleSendMinutes: 10,
    scriptLines: lang === "zh"
      ? ["继续执行", "如果有未完成的步骤，继续"]
      : ["Continue", "If any steps are unfinished, continue"],
    idleStop: false,
    limitPause: true,
    sound: true,
    noSleep: true,
  }
}

/** 0 或非有限正数表示没有截止时间。 */
export function durationDeadline(now: number, durationSeconds: number): number {
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return now + durationSeconds * 1000
  return Number.POSITIVE_INFINITY
}

export function freshState(now: number, durationSeconds: number): State {
  return {
    clicks: 0,
    lastErrorAt: now,
    cooldownUntil: 0,
    idleSince: null,
    idleBaseline: null,
    idleIdx: 0,
    postSendUntil: 0,
    exhausted: false,
    limitCount: -1,
    limitStableSince: now,
    limitWas: false,
    limitHintAt: 0,
    rowCount: -1,
    rowsStableSince: now,
    residualHintAt: 0,
    userHintAt: 0,
    lastScrollAt: 0,
    deadline: durationDeadline(now, durationSeconds),
    running: true,
  }
}

export function classifyLabel(label: string): ButtonKind {
  const text = label.trim()
  if (RETRY_TITLES.includes(text as (typeof RETRY_TITLES)[number])) return "retry"
  if (BUSY_TITLES.includes(text as (typeof BUSY_TITLES)[number])) return "busy"
  if (SCROLL_TITLES.includes(text as (typeof SCROLL_TITLES)[number])) return "scroll"
  if (RESET_TITLES.some((name) => text.toLowerCase() === name.toLowerCase())) return "reset"
  return "other"
}

export function textHits(text: string, keywords: readonly string[]): boolean {
  const hay = text.toLowerCase()
  return keywords.some((k) => k && hay.includes(k.toLowerCase()))
}

/** 取文案里最后一条重置时间。英文大小写不敏感。 */
export function parseLimitReset(raw: string, now: Date): Date | null {
  const s = raw.replace(/\n/g, " ")
  const last = (re: RegExp): RegExpExecArray | null => {
    let found: RegExpExecArray | null = null
    for (const m of s.matchAll(re)) found = m
    return found
  }
  const full = last(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/g)
  if (full) {
    const d = new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5], 0, 0)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const md = last(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/g)
  if (md) {
    const d = new Date(now.getFullYear(), +md[1] - 1, +md[2], +md[3], +md[4], 0, 0)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const en = last(/reset[^0-9]{0,30}(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\.?/gi)
  if (en) {
    let hour = +en[1]
    const pm = en[3].toUpperCase() === "P"
    if (pm && hour < 12) hour += 12
    if (!pm && hour === 12) hour = 0
    if (hour > 23) return null
    const d = new Date(now)
    d.setHours(hour, +en[2], 0, 0)
    return d
  }
  return null
}

export function limitResetAt(texts: string[], now: Date): Date | null {
  const parsed = texts
    .map((s) => parseLimitReset(s, now))
    .filter((d): d is Date => d != null)
  const future = parsed.filter((d) => d.getTime() > now.getTime())
  if (future.length) return future.reduce((a, b) => (a > b ? a : b))
  return parsed.at(-1) ?? null
}

export function pickRetry(buttons: ButtonObs[], errorYs: number[]): ButtonObs | null {
  const retries = buttons.filter((b) => b.kind === "retry")
  if (!retries.length || !errorYs.length) return null
  const rowY = Math.max(...errorYs)
  const near = retries.filter((b) => Math.abs(b.y - rowY) < 80)
  if (near.length) return near.reduce((a, b) => (a.y >= b.y ? a : b))
  if (retries.length === 1) return retries[0]
  return null
}

function fmtMdhm(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function step(obs: Observation, prev: State, cfg: Config): StepResult {
  const state: State = { ...prev }
  const logs: string[] = []
  const interval = Math.max(1, cfg.intervalSeconds) * 1000
  const lang = cfg.lang
  const say = (en: string, zh: string) => logs.push(t(lang, en, zh))

  if (!state.running || (Number.isFinite(state.deadline) && obs.now >= state.deadline)) {
    state.running = false
    const reason = t(lang, "preset duration reached", "已到设定时长")
    say(`⏹ ${reason}`, `⏹ ${reason}`)
    return { action: { type: "stop", reason }, state, logs, delayMs: interval }
  }

  const hasRetry = obs.buttons.some((b) => b.kind === "retry")
  const busy = obs.buttons.some((b) => b.kind === "busy")
  const scroll = obs.buttons.find((b) => b.kind === "scroll")

  const rowCount = obs.errorYs.length
  if (rowCount !== state.rowCount) {
    const transition = state.rowCount < 0 ? `${rowCount}` : `${state.rowCount}→${rowCount}`
    state.rowCount = rowCount
    state.rowsStableSince = obs.now
    say(`⏱ Error lines: ${transition}`, `⏱ 错误行 ${transition} 条`)
  }

  if (obs.limitTexts.length !== state.limitCount) {
    state.limitCount = obs.limitTexts.length
    state.limitStableSince = obs.now
  }
  const stableLimit = obs.now - state.limitStableSince
  const reset = limitResetAt(obs.limitTexts, new Date(obs.now))
  const limitActive = cfg.limitPause && obs.limitTexts.length > 0 && !hasRetry
    && (reset != null ? obs.now < reset.getTime() : stableLimit < 600_000)

  if (limitActive) {
    if (!state.limitWas) {
      state.limitWas = true
      const until = reset
        ? t(lang, `, expected reset ${fmtMdhm(reset.getTime())}`, `，预计 ${fmtMdhm(reset.getTime())} 重置`)
        : ""
      say(
        `⏸ Usage limit reached; retry and idle send paused${until}. Won't press Reset usage`,
        `⏸ 用量已达上限，暂停重试与空闲发送${until}。不会代点「重置使用量」`,
      )
    } else if (obs.now - state.limitHintAt > 600_000) {
      say("⏸ Still usage-limited; waiting for quota reset", "⏸ 仍处于用量上限状态，继续等待额度重置")
    }
    state.limitHintAt = obs.now
    state.idleSince = null
    state.idleBaseline = null
    state.lastErrorAt = obs.now
    return { action: { type: "noop" }, state, logs, delayMs: interval }
  }
  if (state.limitWas) {
    state.limitWas = false
    say("✅ Usage limit cleared", "✅ 额度上限已解除，恢复正常监控")
  }

  const residual = rowCount > 0 && !hasRetry && !busy && obs.now - state.rowsStableSince >= 60_000
  if (residual && obs.now - state.residualHintAt > 120_000) {
    state.residualHintAt = obs.now
    say(
      `ℹ️ ${rowCount} leftover error line(s), no Retry button, stable for 60s — treating as idle`,
      `ℹ️ 错误行 ${rowCount} 条已稳定 60 秒且无「重试」按钮，视为空闲`,
    )
  }
  const idle = (rowCount === 0 && !hasRetry && !busy) || residual

  if (!idle) {
    state.idleSince = null
    state.idleBaseline = null
    state.lastErrorAt = obs.now
    if (obs.now < state.cooldownUntil) {
      const wait = Math.max(200, Math.min(interval, state.cooldownUntil - obs.now + 500))
      return { action: { type: "noop" }, state, logs, delayMs: wait }
    }
    if (obs.userActive) {
      if (obs.now - state.userHintAt > 120_000) {
        state.userHintAt = obs.now
        say("ℹ️ You're typing; skipping this cycle", "ℹ️ 正在输入，本轮跳过，避免打断")
      }
      return { action: { type: "noop" }, state, logs, delayMs: interval }
    }
    if (hasRetry) {
      // 页面会按每个已挂载会话各自的按钮来点。坐标对不上时也不能整轮放弃。
      const btn = pickRetry(obs.buttons, obs.errorYs)
      const y = btn?.y ?? obs.buttons.find((b) => b.kind === "retry")!.y
      state.clicks += 1
      say(
        `🖱 Press #${state.clicks} at y=${Math.round(y)}`,
        `🖱 按压 #${state.clicks}`,
      )
      return { action: { type: "click", y }, state, logs, delayMs: interval }
    }
    if (scroll && obs.now - state.lastScrollAt > 5000) {
      state.lastScrollAt = obs.now
      say(
        "⬇️ View not at bottom; scrolled down and will rescan",
        "⬇️ 界面未滚到底，已滚动到底并重新读取",
      )
      return { action: { type: "scroll" }, state, logs, delayMs: 800 }
    }
    return { action: { type: "noop" }, state, logs, delayMs: interval }
  }

  if (scroll && obs.now - state.lastScrollAt > 5000 && !obs.userActive) {
    state.lastScrollAt = obs.now
    say(
      "⬇️ View not at bottom; scrolled down and will rescan",
      "⬇️ 界面未滚到底，已滚动到底并重新读取",
    )
    return { action: { type: "scroll" }, state, logs, delayMs: 800 }
  }

  const sent = idleSend(obs, state, cfg, say)
  if (sent) return { action: sent, state, logs, delayMs: interval }
  return { action: { type: "noop" }, state, logs, delayMs: interval }
}

function idleSend(
  obs: Observation,
  state: State,
  cfg: Config,
  say: (en: string, zh: string) => void,
): Action | null {
  if (!cfg.idleSendEnabled || cfg.idleSendMinutes <= 0) return null
  if (state.idleSince == null) state.idleSince = obs.mono
  let changed = false
  if (obs.inputValue != null) {
    if (state.idleBaseline == null) state.idleBaseline = obs.inputValue
    else if (obs.inputValue !== state.idleBaseline) {
      state.idleBaseline = obs.inputValue
      state.idleSince = obs.mono
      changed = true
    }
  }
  const lines = cfg.scriptLines.map((s) => s.trim()).filter(Boolean)
  if (lines.length && state.idleIdx >= lines.length) {
    if (!state.exhausted) {
      state.exhausted = true
      say(`✅ All ${lines.length} command lines sent`, `✅ ${lines.length} 行指令已全部发送完毕`)
    }
    return { type: "noop" }
  }
  const idleMs = obs.mono - (state.idleSince ?? obs.mono)
  if (changed || !lines.length || idleMs < cfg.idleSendMinutes * 60_000) return { type: "noop" }
  if (state.postSendUntil && obs.mono < state.postSendUntil) return { type: "noop" }
  if (obs.userActive) return { type: "noop" }
  const line = lines[state.idleIdx]
  say(
    `💬 Idle ${Math.floor(idleMs / 60000)} min, sending line ${state.idleIdx + 1}/${lines.length}`,
    `💬 已空闲 ${Math.floor(idleMs / 60000)} 分钟，发送第 ${state.idleIdx + 1}/${lines.length} 行`,
  )
  return { type: "idle-send", line }
}

/** 发送结果回写。sent 推进行号；其它情况 60 秒后再试同一行。 */
export function noteSend(state: State, result: "sent" | "busy" | "nofield" | "unclear", cfg: Config, mono: number): State {
  const next = { ...state }
  const minutes = cfg.idleSendMinutes
  if (result === "sent") {
    next.idleIdx += 1
    next.idleSince = mono
    next.postSendUntil = mono + Math.max(minutes * 60_000, 300_000)
    next.idleBaseline = null
    return next
  }
  next.idleSince = mono - minutes * 60_000 + 60_000
  return next
}

/** 点击后错误还在、按钮没了：20 秒内不再按，等服务端恢复。 */
export function noteClickResult(state: State, effective: boolean, errorRemains: boolean, now: number): State {
  const next = { ...state }
  if (effective && errorRemains) next.cooldownUntil = now + 20_000
  return next
}

export function scriptLinesFromText(text: string): string[] {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

export function configFromJson(raw: unknown, lang: Lang): Config {
  const cfg = defaultConfig(lang)
  if (!raw || typeof raw !== "object") return cfg
  const o = raw as Record<string, unknown>
  if (o.language === "zh" || o.language === "en") cfg.lang = o.language
  const iv = o.intervalSeconds
  if (typeof iv === "number" && iv >= 1 && iv <= 3600) cfg.intervalSeconds = iv
  const choice = o.durationChoice
  const custom = typeof o.customMinutes === "number" ? o.customMinutes : 45
  if (choice === "15" || choice === "30" || choice === "60" || choice === "120") {
    cfg.durationSeconds = Number(choice) * 60
  } else if (choice === "custom") {
    cfg.durationSeconds = Math.max(1, custom) * 60
  } else if (choice === "0" || choice === "unlimited" || choice === "forever" || choice === "inf" || choice === "none") {
    cfg.durationSeconds = 0
  }
  if (typeof o.durationSeconds === "number" && Number.isFinite(o.durationSeconds)) {
    if (o.durationSeconds === 0) cfg.durationSeconds = 0
    else if (o.durationSeconds >= 60) cfg.durationSeconds = o.durationSeconds
  }
  if (Array.isArray(o.errorKeywords) && o.errorKeywords.every((k) => typeof k === "string") && o.errorKeywords.length) {
    cfg.errorKeywords = o.errorKeywords.map((k) => k.toLowerCase())
  }
  if (typeof o.idleSendEnabled === "boolean") cfg.idleSendEnabled = o.idleSendEnabled
  if (typeof o.idleSendMinutes === "number" && o.idleSendMinutes >= 1 && o.idleSendMinutes <= 1440) {
    cfg.idleSendMinutes = o.idleSendMinutes
  }
  if (Array.isArray(o.scriptLines) && o.scriptLines.every((k) => typeof k === "string")) {
    cfg.scriptLines = o.scriptLines
  }
  if (typeof o.idleStop === "boolean") cfg.idleStop = o.idleStop
  if (typeof o.limitPause === "boolean") cfg.limitPause = o.limitPause
  if (typeof o.sound === "boolean") cfg.sound = o.sound
  if (typeof o.noSleep === "boolean") cfg.noSleep = o.noSleep
  return cfg
}

export function parseDuration(text: string): number | null {
  const raw = text.trim().toLowerCase()
  if (raw === "0" || raw === "inf" || raw === "infinity" || raw === "unlimited" || raw === "forever" || raw === "none") {
    return 0
  }
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || "m").toLowerCase()
  if (unit === "s") return n
  if (unit === "h") return n * 3600
  return n * 60
}
