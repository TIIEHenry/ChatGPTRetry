import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { wantTarget } from "../src/injector.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

test("target filter stays on the Codex app page", () => {
  assert.equal(wantTarget("app://-/index.html", "app"), true)
  assert.equal(wantTarget("app://fs/apps/vscode.png", "app"), false)
  assert.equal(wantTarget("https://example.com", "app"), false)
  assert.equal(wantTarget("devtools://devtools/bundled/inspector.html", "any"), false)
  assert.equal(wantTarget("http://127.0.0.1:9/fixture.html", "any"), true)
})

test("injected script clicks Retry and does not click Reset usage", { timeout: 45_000 }, async () => {
  const html = await import("node:fs").then((fs) => fs.readFileSync(join(here, "fixture.html")))
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  const url = `http://127.0.0.1:${addr.port}/fixture.html`
  const port = 9337
  const profile = mkdtempSync(join(tmpdir(), "retrypilot-chrome-"))
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: "ignore" })
  const configDir = mkdtempSync(join(tmpdir(), "retrypilot-cfg-"))
  const injector = spawn(process.execPath, [
    "--experimental-strip-types",
    join(root, "src/injector.ts"),
    "--no-launch",
    "--port", String(port),
    "--target", "any",
    "--interval", "1",
    "--duration", "5m",
  ], {
    cwd: root,
    env: { ...process.env, RETRYPILOT_CONFIG_DIR: configDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let injectorLog = ""
  injector.stdout?.on("data", (b) => { injectorLog += b })
  injector.stderr?.on("data", (b) => { injectorLog += b })
  try {
    let clicked = 0
    let hiddenClicked = 0
    let reset = 0
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const counts = await readCounts(port)
      if (counts) {
        clicked = counts.clicked
        hiddenClicked = counts.hiddenClicked
        reset = counts.reset
        if (clicked >= 1 && hiddenClicked >= 1) break
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    assert.ok(clicked >= 1, `Retry was not clicked. injector: ${injectorLog}`)
    assert.ok(hiddenClicked >= 1, `Hidden session retry was not clicked. injector: ${injectorLog}`)
    assert.equal(reset, 0)
  } finally {
    injector.kill("SIGTERM")
    chrome.kill("SIGTERM")
    server.close()
  }
})

async function readCounts(port: number): Promise<{ clicked: number; hiddenClicked: number; reset: number } | null> {
  let list: Array<{ type: string; webSocketDebuggerUrl?: string; url: string }>
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return null
    list = await res.json() as typeof list
  } catch {
    return null
  }
  const page = list.find((t) => t.type === "page" && t.url.includes("fixture.html") && t.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("cdp")))
  })
  const result = await new Promise<{ clicked?: number; hiddenClicked?: number; reset?: number }>((resolve, reject) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === 1) resolve(msg.result?.result?.value ?? {})
    })
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "({clicked: window.__clicked || 0, hiddenClicked: window.__hiddenClicked || 0, reset: window.__reset || 0})", returnByValue: true },
    }))
    setTimeout(() => reject(new Error("timeout")), 2000)
  }).finally(() => ws.close())
  return { clicked: result.clicked || 0, hiddenClicked: result.hiddenClicked || 0, reset: result.reset || 0 }
}
