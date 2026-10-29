/**
 * 注入到 Codex 页面里的脚本。
 * 找到「重试」后在页面内部触发点击：不移动鼠标，不把窗口拉到前台，也不切换当前会话。
 * 左右滑动留下的相邻会话宽高为 0，按钮还可能处于「请求中」的禁用状态。
 * 这种按钮直接调用它自己的 React onClick，点完焦点还给原来的输入框。
 */
import {
  type Config,
  type Observation,
  type State,
  classifyLabel,
  defaultConfig,
  freshState,
  noteClickResult,
  noteSend,
  step,
  textHits,
} from "./logic.ts"

const MARK = "__codexRetryPilot"
const BUILD = "bg-retry-2"

interface Pilot {
  running: boolean
  build?: string
  state: State
  cfg: Config
  timer: number
  lastInputAt: number
  logs: string[]
}

function pilot(): Pilot {
  const w = globalThis as unknown as Record<string, Pilot | undefined>
  let cur = w[MARK]
  if (!cur) {
    cur = {
      running: false,
      state: freshState(Date.now(), defaultConfig().durationSeconds),
      cfg: defaultConfig(),
      timer: 0,
      lastInputAt: 0,
      logs: [],
    }
    w[MARK] = cur
  }
  return cur
}

export function apply(partial: Partial<Config>): void {
  const p = pilot()
  p.cfg = { ...p.cfg, ...partial, errorKeywords: partial.errorKeywords ?? p.cfg.errorKeywords, scriptLines: partial.scriptLines ?? p.cfg.scriptLines }
}

export function stop(reason = "stopped"): void {
  const p = pilot()
  if (!p.running) return
  p.running = false
  p.state.running = false
  if (p.timer) window.clearTimeout(p.timer)
  p.timer = 0
  log(`⏹ ${reason}`)
}

export function start(partial: Partial<Config> = {}): void {
  const p = pilot()
  apply(partial)
  if (p.running && p.build === BUILD) return
  if (p.timer) window.clearTimeout(p.timer)
  p.timer = 0
  p.build = BUILD
  p.running = true
  p.state = freshState(Date.now(), p.cfg.durationSeconds)
  p.state.running = true
  armInputWatch()
  log(`▶️ injected | every ${p.cfg.intervalSeconds}s | ${Math.round(p.cfg.durationSeconds / 60)} min`)
  queue(400)
}

function armInputWatch(): void {
  const w = globalThis as unknown as { __codexRetryPilotInput?: boolean }
  if (w.__codexRetryPilotInput) return
  w.__codexRetryPilotInput = true
  const mark = () => { pilot().lastInputAt = Date.now() }
  document.addEventListener("keydown", mark, true)
  document.addEventListener("pointerdown", mark, true)
  document.addEventListener("wheel", mark, true)
}

function queue(ms: number): void {
  const p = pilot()
  if (p.timer) window.clearTimeout(p.timer)
  p.timer = window.setTimeout(tick, ms)
}

function tick(): void {
  const p = pilot()
  p.timer = 0
  if (!p.running) return
  runBody()
}

function runBody(): void {
  const p = pilot()
  if (!p.running) return
  const obs = collect(p.cfg.errorKeywords, p.lastInputAt)
  const decided = step(obs, p.state, p.cfg)
  p.state = decided.state
  for (const line of decided.logs) log(line)
  if (decided.action.type === "stop") {
    stop(decided.action.reason)
    return
  }
  if (decided.action.type === "scroll") {
    pressKind("scroll")
    window.setTimeout(() => { if (pilot().running) runBody() }, 700)
    return
  }
  if (decided.action.type === "click") {
    const clicked = pressMountedRetries(p.cfg.errorKeywords)
    if (clicked > 1) log(`🖱 本轮共点了 ${clicked} 个会话的重试`)
    window.setTimeout(() => {
      if (!pilot().running) return
      const after = collect(pilot().cfg.errorKeywords, pilot().lastInputAt)
      const still = mountedRetryButtons(pilot().cfg.errorKeywords).length
      const gone = clicked > 0 && (still === 0 || after.errorYs.length === 0)
      pilot().state = noteClickResult(pilot().state, clicked > 0 && gone, after.errorYs.length > 0, Date.now())
      if (clicked > 0 && gone) log(after.errorYs.length ? "⌛️ retry in flight" : "✅ error cleared")
      queue(decided.delayMs)
    }, 1200)
    return
  }
  if (decided.action.type === "idle-send") {
    const line = decided.action.line
    const result = sendLine(line, obs.inputValue)
    pilot().state = noteSend(pilot().state, result, pilot().cfg, performance.now())
    log(result === "sent" ? "✅ idle send done" : `⚠️ idle send ${result}`)
  }
  if (p.running) queue(decided.delayMs)
}

function collect(keywords: string[], lastInputAt: number): Observation {
  const buttons = collectButtons()
  const errorYs = collectHits(keywords).map((el) => midY(el))
  // 左右滑动会把相邻会话留在 DOM 里，但宽高为 0，按钮也可能是禁用的。
  // 这些「重试」都要计入，否则后台会话永远点不到。
  for (const el of mountedRetryButtons(keywords)) {
    if (shown(el) && !disabled(el)) continue
    const y = shown(el) ? midY(el) : slotY(el)
    buttons.push({ label: buttonLabel(el), y, kind: "retry" })
    if (!shown(el)) errorYs.push(y)
  }
  return {
    errorYs,
    limitTexts: collectHits([
      "使用上限", "额度已用完", "usage limit", "codex and work usage", "rate limit resets",
    ]).map((el) => (el.textContent || "").trim()).filter(Boolean),
    buttons,
    inputValue: readComposer(),
    userActive: Date.now() - lastInputAt < 3000,
    now: Date.now(),
    mono: performance.now(),
  }
}

function collectButtons(): Observation["buttons"] {
  const out: Observation["buttons"] = []
  for (const el of queryDeep("button, [role='button']")) {
    if (!(el instanceof HTMLElement) || !shown(el) || disabled(el)) continue
    const label = buttonLabel(el)
    const kind = classifyLabel(label)
    if (kind === "other") continue
    out.push({ label, y: midY(el), kind })
  }
  return out
}

function collectHits(keywords: string[]): Element[] {
  const hits: Element[] = []
  for (const el of queryDeep("*")) {
    if (!shown(el)) continue
    const own = (el.textContent || "").replace(/\s+/g, " ").trim()
    if (!own || own.length > 800 || !textHits(own, keywords)) continue
    let childHas = false
    for (const child of el.children) {
      const t = (child.textContent || "").replace(/\s+/g, " ").trim()
      if (t && textHits(t, keywords)) { childHas = true; break }
    }
    if (!childHas) hits.push(el)
  }
  return hits
}

function queryDeep(selector: string, root: ParentNode = document): Element[] {
  const out = [...root.querySelectorAll(selector)]
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) out.push(...queryDeep(selector, el.shadowRoot))
  }
  return out
}

function shown(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  const style = getComputedStyle(el)
  return style.display !== "none" && style.visibility !== "hidden"
}

function midY(el: Element): number {
  const r = el.getBoundingClientRect()
  return r.top + r.height / 2
}

function buttonLabel(el: HTMLElement): string {
  const candidates = [el.getAttribute("aria-label") || "", el.innerText || "", el.getAttribute("title") || ""]
  for (const raw of candidates) {
    const text = raw.trim()
    if (text && classifyLabel(text) !== "other") return text
  }
  return (el.innerText || el.getAttribute("aria-label") || "").trim()
}

function disabled(el: HTMLElement): boolean {
  return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
}

/** 每个已挂载的会话各点自己的「重试」，包括宽高为 0、以及卡在禁用状态的相邻会话。 */
function pressMountedRetries(keywords: string[]): number {
  const buttons = mountedRetryButtons(keywords)
  let hidden = 0
  for (const el of buttons) {
    if (!shown(el)) hidden += 1
    pressRetry(el)
  }
  if (hidden > 0) log(`🖱 后台会话 ${hidden} 个，不切换窗口`)
  return buttons.length
}

function mountedRetryButtons(keywords: string[]): HTMLElement[] {
  const roots = conversationRoots()
  const out: HTMLElement[] = []
  for (const root of roots) {
    const text = rootText(root)
    if (!textHits(text, keywords)) continue
    for (const el of queryDeep("button, [role='button']", root)) {
      if (!(el instanceof HTMLElement) || !painted(el)) continue
      if (classifyLabel(buttonLabel(el)) !== "retry") continue
      out.push(el)
    }
  }
  return out
}

interface ReactHook {
  memoizedState: unknown
  next: ReactHook | null
  queue: { dispatch?: (value: unknown) => void } | null
}

interface ReactFiber {
  return: ReactFiber | null
  memoizedProps: Record<string, unknown> | null
  memoizedState: ReactHook | null
}

function reactKey(el: HTMLElement, prefix: string): string | undefined {
  return Object.keys(el).find((key) => key.startsWith(prefix))
}

function reactFiber(el: HTMLElement): ReactFiber | null {
  const key = reactKey(el, "__reactFiber$")
  if (!key) return null
  return (el as unknown as Record<string, ReactFiber | undefined>)[key] ?? null
}

/** 容量重试的禁用只表示「请求已发出」。请求悄悄返回后按钮会一直禁用，后台会话就再也不点了。 */
function releaseInFlight(el: HTMLElement): boolean {
  let fiber = reactFiber(el)
  for (let i = 0; fiber && i < 40; i += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps
    if (!props || !("retryDelaySeconds" in props)) continue
    let hook: ReactHook | null = fiber.memoizedState
    for (let h = 0; hook && h < 12; h += 1, hook = hook.next) {
      if (hook.memoizedState !== true || typeof hook.queue?.dispatch !== "function") continue
      hook.queue.dispatch(false)
      return true
    }
    return false
  }
  return false
}

function callOnClick(el: HTMLElement): void {
  const key = reactKey(el, "__reactProps$")
  if (!key) return
  const props = (el as unknown as Record<string, { onClick?: (event: Event) => void } | undefined>)[key]
  if (typeof props?.onClick !== "function") return
  props.onClick(new Event("click"))
}

function retryInRoot(root: Element | null): HTMLElement | null {
  if (!root) return null
  for (const el of queryDeep("button, [role='button']", root)) {
    if (!(el instanceof HTMLElement) || !painted(el)) continue
    if (classifyLabel(buttonLabel(el)) === "retry") return el
  }
  return null
}

function pressRetry(el: HTMLElement): void {
  const root = el.closest("main[data-codex-history-swipe-page]")
  const stuck = disabled(el)
  if (stuck) releaseInFlight(el)
  const fire = () => {
    const target = el.isConnected ? el : retryInRoot(root)
    if (!target || !target.isConnected) return
    callOnClick(target)
    if (!disabled(target)) backgroundClick(target)
  }
  if (stuck) window.setTimeout(fire, 120)
  else fire()
}

function conversationRoots(): ParentNode[] {
  const mains = [...document.querySelectorAll("main[data-codex-history-swipe-page]")]
  return mains.length ? mains : [document]
}

function rootText(root: ParentNode): string {
  if (root instanceof Document) return root.body?.textContent || ""
  return (root as Element).textContent || ""
}

function slotY(el: HTMLElement): number {
  const mains = [...document.querySelectorAll("main[data-codex-history-swipe-page]")]
  const main = el.closest("main[data-codex-history-swipe-page]")
  const idx = main ? mains.indexOf(main) : 0
  return -100000 - Math.max(0, idx) * 500
}

function painted(el: HTMLElement): boolean {
  const style = getComputedStyle(el)
  return style.display !== "none" && style.visibility !== "hidden"
}

function pressKind(kind: "scroll"): void {
  for (const el of queryDeep("button, [role='button']")) {
    if (!(el instanceof HTMLElement) || !shown(el) || disabled(el)) continue
    if (classifyLabel(buttonLabel(el)) === kind) {
      backgroundClick(el)
      return
    }
  }
}

/** 可信 click()。点完把焦点还给原来的输入框，避免打断正在打的字。 */
function backgroundClick(el: HTMLElement): void {
  const active = document.activeElement
  el.click()
  if (active instanceof HTMLElement && active !== el && document.contains(active)) {
    active.focus({ preventScroll: true })
  }
}

function composer(): HTMLElement | null {
  const nodes = queryDeep("textarea, [contenteditable='true'], [role='textbox']")
    .filter((el): el is HTMLElement => el instanceof HTMLElement && shown(el))
  if (!nodes.length) return null
  return nodes.reduce((a, b) => (midY(a) >= midY(b) ? a : b))
}

function readComposer(): string | null {
  const el = composer()
  if (!el) return null
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return el.innerText ?? ""
}

function sendLine(line: string, baseline: string | null): "sent" | "busy" | "nofield" | "unclear" {
  const el = composer()
  if (!el) return "nofield"
  const current = readComposer()
  if (current == null) return "nofield"
  if (current.length > 8000) return "nofield"
  const trimmed = current.trim()
  if (trimmed && current !== baseline) return "busy"
  const written = writeComposer(el, line)
  if (!written) return "unclear"
  const send = findSendButton(el)
  if (send) backgroundClick(send)
  else dispatchEnter(el)
  const after = readComposer()
  if (after != null && after !== line) return "sent"
  writeComposer(el, "")
  return "unclear"
}

function writeComposer(el: HTMLElement, value: string): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")
    proto?.set?.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return el.value === value
  }
  el.focus({ preventScroll: true })
  el.textContent = value
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
  return (el.innerText || "").trim() === value.trim()
}

function findSendButton(composerEl: HTMLElement): HTMLElement | null {
  const names = new Set(["发送", "send", "send message", "发送消息"])
  const y = midY(composerEl)
  let best: HTMLElement | null = null
  let bestDy = Infinity
  for (const el of queryDeep("button, [role='button']")) {
    if (!(el instanceof HTMLElement) || !shown(el)) continue
    const label = buttonLabel(el).toLowerCase()
    if (!names.has(label)) continue
    const dy = Math.abs(midY(el) - y)
    if (dy < bestDy) { best = el; bestDy = dy }
  }
  return best && bestDy < 200 ? best : null
}

function dispatchEnter(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
}

function log(line: string): void {
  const p = pilot()
  p.logs.push(line)
  if (p.logs.length > 200) p.logs.splice(0, p.logs.length - 200)
  console.info(`[codexretry] ${line}`)
}
