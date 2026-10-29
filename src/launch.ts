/** 找到本机 ChatGPT 桌面进程，必要时用调试端口重新拉起。 */

import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"

const BIN_CANDIDATES = ["/usr/bin/chatgpt", "/usr/lib/chatgpt/ChatGPT"]

export function chatgptBin(): string | null {
  for (const p of BIN_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return null
}

export function mainChatgptPids(): number[] {
  const pids: number[] = []
  let entries: string[] = []
  try { entries = readdirSync("/proc") } catch { return pids }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    let exe = ""
    try { exe = readlinkSync(`/proc/${pid}/exe`) } catch { continue }
    if (!exe.endsWith("/ChatGPT")) continue
    let cmd = ""
    try { cmd = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ") } catch { continue }
    if (cmd.includes("--type=")) continue
    pids.push(pid)
  }
  return pids
}

export function launchChatgpt(port: number): void {
  const bin = chatgptBin()
  if (!bin) throw new Error("找不到 ChatGPT 桌面版（/usr/bin/chatgpt）")
  const child = spawn(bin, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

export async function stopPids(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
  }
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const live = pids.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (!live.length) return
    await new Promise((r) => setTimeout(r, 200))
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL") } catch { /* gone */ }
  }
}
