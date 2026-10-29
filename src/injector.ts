/**
 * 把 page.bundle.js 注入到 ChatGPT 的页面里，并保持连接。
 * 调试端口只监听本机。注入用的是页面自己的 click()，不移动鼠标、不抢焦点。
 */
import { readFileSync, mkdirSync, appendFileSync, watch, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { configFromJson, defaultConfig, parseDuration, type Config, type Lang } from "./logic.ts"
import { chatgptBin, launchChatgpt, mainChatgptPids, stopPids } from "./launch.ts"

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, "..", "page.bundle.js")

interface Args {
  port: number
  restart: boolean
  noLaunch: boolean
  target: "app" | "any"
  duration: number | null
  interval: number | null
}

function parseArgs(argv: string[]): Args {
  const out: Args = { port: 9333, restart: false, noLaunch: false, target: "app", duration: null, interval: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--restart") out.restart = true
    else if (a === "--no-launch") out.noLaunch = true
    else if (a === "--port") out.port = Number(next())
    else if (a === "--target") out.target = next() === "any" ? "any" : "app"
    else if (a === "--duration") out.duration = parseDuration(next() || "")
    else if (a === "--interval") out.interval = Number(next())
    else if (a === "--help" || a === "-h") {
      console.log(`用法: codexretry [--restart] [--port 9333] [--duration 8h] [--interval 10]

把重试脚本注入 ChatGPT 桌面版。脚本在页面内点击「重试」，不移动鼠标。
默认不限时，一直运行到手动停止。--duration 接受 Ns、Nm、Nh，省略单位按分钟；0 或 unlimited 仍表示不限时。
已经开着的 ChatGPT 没有调试端口，需要 --restart 才会退出并重新打开。`)
      process.exit(0)
    }
  }
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error("无效端口")
  return out
}

function configDir(): string {
  const base = process.env.RETRYPILOT_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "CodexRetry")
  return base
}

function systemLang(): Lang {
  const blob = `${process.env.LANGUAGE || ""}:${process.env.LC_ALL || ""}:${process.env.LANG || ""}`
  for (const part of blob.split(":")) {
    const p = part.toLowerCase()
    if (p.startsWith("zh")) return "zh"
    if (p.startsWith("en")) return "en"
  }
  return "en"
}

function loadConfig(args: Args): Config {
  const path = join(configDir(), "config.json")
  let cfg = defaultConfig(systemLang())
  if (existsSync(path)) {
    try { cfg = configFromJson(JSON.parse(readFileSync(path, "utf8")), systemLang()) } catch { /* keep default */ }
  }
  if (args.duration != null) cfg.durationSeconds = args.duration
  if (args.interval != null && args.interval >= 1) cfg.intervalSeconds = args.interval
  return cfg
}

function logFile(line: string): void {
  const dir = join(configDir(), "logs")
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const stamp = new Date().toTimeString().slice(0, 8)
  appendFileSync(join(dir, `${day}.log`), `[${stamp}] ${line}\n`)
}

function say(line: string): void {
  console.log(line)
  logFile(line)
}

export function wantTarget(url: string, mode: "app" | "any"): boolean {
  if (!url) return false
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  const proto = parsed.protocol
  if (proto === "devtools:" || proto === "chrome:" || proto === "chrome-extension:" || proto === "codex-sandbox:") return false
  if (mode === "any") return proto === "http:" || proto === "https:" || proto === "app:" || proto === "file:"
  // 主界面是 app://- 或 app://（host 为空）。app://fs 是应用内文件预览，不注入。
  if (proto === "app:") return parsed.host === "-" || parsed.host === ""
  return proto === "file:" && parsed.pathname.includes("index.html")
}

export function isUiTarget(type: string | undefined): boolean {
  return type === "page" || type === "webview" || type === "iframe"
}

interface CdpMsg { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } }

class Cdp {
  private ws: WebSocket | null = null
  private next = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  readonly onEvent: Array<(msg: CdpMsg) => void> = []

  async open(url: string): Promise<void> {
    const ws = new WebSocket(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("调试端口连不上")))
    })
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMsg
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.onEvent) fn(msg)
      }
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.next++
    const payload: CdpMsg = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify(payload))
    })
  }

  close(): void { this.ws?.close() }
}

async function waitForPort(port: number, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const body = await res.json() as { webSocketDebuggerUrl?: string }
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
      }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function ensureApp(args: Args): Promise<void> {
  const existing = await waitForPort(args.port, 400)
  if (existing) return
  const pids = mainChatgptPids()
  if (pids.length && !args.restart) {
    throw new Error(
      `ChatGPT 已在运行（pid ${pids.join(", ")}），但没有调试端口 ${args.port}。\n` +
      `页面脚本只能注入到带调试端口启动的进程。退出 ChatGPT 后执行：\n` +
      `  codexretry --restart`,
    )
  }
  if (args.noLaunch) throw new Error(`127.0.0.1:${args.port} 没有调试端口`)
  if (pids.length) {
    say(`正在退出 ChatGPT（pid ${pids.join(", ")}）并用调试端口重新打开`)
    await stopPids(pids)
  } else if (!chatgptBin()) {
    throw new Error("找不到 /usr/bin/chatgpt")
  }
  say(`启动 ChatGPT --remote-debugging-port=${args.port}`)
  launchChatgpt(args.port)
}

function expression(bundle: string, cfg: Config): string {
  return `${bundle}\nCodexRetryPilot.start(${JSON.stringify(cfg)});`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(bundlePath)) {
    throw new Error(`缺少 ${bundlePath}。先在 linux 目录执行 npm install && npm run build`)
  }
  const bundle = readFileSync(bundlePath, "utf8")
  let cfg = loadConfig(args)
  await ensureApp(args)
  const wsUrl = await waitForPort(args.port, 30_000)
  if (!wsUrl) throw new Error("ChatGPT 没有在 30 秒内打开调试端口")
  const cdp = new Cdp()
  await cdp.open(wsUrl)
  const sessions = new Map<string, string>()

  const inject = async (sessionId: string, source: string) => {
    await cdp.send("Runtime.enable", {}, sessionId).catch(() => undefined)
    await cdp.send("Page.enable", {}, sessionId).catch(() => undefined)
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId).catch(() => undefined)
    await cdp.send("Runtime.evaluate", { expression: source, returnByValue: true }, sessionId)
  }

  const pending = new Set<string>()
  const attach = async (targetId: string, url: string) => {
    if (sessions.has(targetId) || pending.has(targetId) || !wantTarget(url, args.target)) return
    pending.add(targetId)
    try {
      const result = await cdp.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId?: string }
      const sessionId = result.sessionId
      if (!sessionId) return
      sessions.set(targetId, sessionId)
      say(`注入 ${url}`)
      await inject(sessionId, expression(bundle, cfg))
    } finally {
      pending.delete(targetId)
    }
  }

  cdp.onEvent.push((msg) => {
    if (msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") {
      const info = msg.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined
      if (isUiTarget(info?.type) && info?.targetId && info.url) {
        attach(info.targetId, info.url).catch((err) => say(`注入失败 ${info.url}: ${err.message}`))
      }
    }
    if (msg.method === "Target.targetDestroyed") {
      const id = msg.params?.targetId as string | undefined
      if (id) sessions.delete(id)
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const argsList = (msg.params?.args as Array<{ value?: unknown }> | undefined) || []
      const text = argsList.map((a) => String(a.value ?? "")).join(" ")
      if (text.includes("[codexretry]")) say(text.replace("[codexretry] ", ""))
    }
  })

  await cdp.send("Target.setDiscoverTargets", { discover: true })
  const listed = await cdp.send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string }> }
  for (const info of listed.targetInfos || []) {
    if (isUiTarget(info.type)) await attach(info.targetId, info.url)
  }
  const span = cfg.durationSeconds > 0 ? `时长 ${Math.round(cfg.durationSeconds / 60)} 分钟` : "不限时"
  say(`监控中。间隔 ${cfg.intervalSeconds}s，${span}。日志在 ${join(configDir(), "logs")}`)

  const cfgPath = join(configDir(), "config.json")
  if (existsSync(cfgPath)) {
    watch(cfgPath, () => {
      cfg = loadConfig(args)
      const src = `CodexRetryPilot.apply(${JSON.stringify(cfg)});`
      for (const sessionId of sessions.values()) {
        cdp.send("Runtime.evaluate", { expression: src, returnByValue: true }, sessionId).catch(() => undefined)
      }
      say("配置已重新载入")
    })
  }

  if (cfg.noSleep) holdAwake()
  process.on("SIGTERM", () => process.exit(0))
  process.on("SIGINT", () => process.exit(0))

  await new Promise(() => {})
}

function holdAwake(): void {
  import("node:child_process").then(({ spawn }) => {
    const child = spawn("systemd-inhibit", [
      "--what=idle:sleep",
      "--who=codexretry",
      "--why=monitoring Codex",
      "--mode=block",
      "sleep", "infinity",
    ], { stdio: "ignore" })
    child.on("error", () => undefined)
    process.on("exit", () => child.kill())
  }).catch(() => undefined)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (invoked === import.meta.url) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
