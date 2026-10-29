import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyLabel,
  configFromJson,
  defaultConfig,
  freshState,
  noteClickResult,
  noteSend,
  parseLimitReset,
  pickRetry,
  step,
  type ButtonObs,
  type Observation,
} from "../src/logic.ts"

function obs(partial: Partial<Observation> = {}): Observation {
  return {
    errorYs: [],
    limitTexts: [],
    buttons: [],
    inputValue: null,
    userActive: false,
    now: 1_000_000,
    mono: 1_000_000,
    ...partial,
  }
}

const retry = (y: number): ButtonObs => ({ label: "重试", y, kind: "retry" })

test("parse Chinese reset time and English PM", () => {
  const now = new Date(2026, 9, 20, 8, 0, 0)
  const cn = parseLimitReset("将于 2026年10月25日 00:14后重试", now)
  assert.equal(cn?.getFullYear(), 2026)
  assert.equal(cn?.getMonth(), 9)
  assert.equal(cn?.getDate(), 25)
  assert.equal(cn?.getHours(), 0)
  assert.equal(cn?.getMinutes(), 14)
  const en = parseLimitReset("Your limit Resets at 4:00 PM", now)
  assert.equal(en?.getHours(), 16)
  assert.equal(en?.getMinutes(), 0)
  assert.equal(parseLimitReset("no time here", now), null)
})

test("click the retry button nearest the lowest error line", () => {
  const cfg = defaultConfig("zh")
  const state = freshState(0, 3600)
  const result = step(obs({
    errorYs: [100, 400],
    buttons: [retry(100), retry(410), { label: "重置使用量", y: 400, kind: "reset" }],
  }), state, cfg)
  assert.equal(result.action.type, "click")
  if (result.action.type === "click") assert.equal(result.action.y, 410)
  assert.equal(result.state.clicks, 1)
})

test("do not click when several retry buttons have no coordinates match and no single candidate", () => {
  const far = pickRetry([retry(10), retry(900)], [400])
  assert.equal(far, null)
  assert.equal(pickRetry([retry(900)], [10])?.y, 900)
})

test("usage limit pauses and never treats reset as a retry", () => {
  const cfg = defaultConfig("zh")
  const now = new Date(2026, 9, 20, 8, 0, 0).getTime()
  const state = freshState(now, 3600)
  const result = step(obs({
    now,
    mono: now,
    limitTexts: ["用量已达上限，将于 2026年10月25日 00:14后重试"],
    buttons: [{ label: "重置使用量", y: 20, kind: "reset" }],
  }), state, cfg)
  assert.equal(result.action.type, "noop")
  assert.match(result.logs.join("\n"), /用量已达上限/)
  assert.equal(classifyLabel("重置使用量"), "reset")
  assert.equal(classifyLabel("Retry"), "retry")
})

test("idle send waits out the quiet period and does not overwrite a new draft", () => {
  const cfg = defaultConfig("zh")
  cfg.idleSendEnabled = true
  cfg.idleSendMinutes = 10
  cfg.scriptLines = ["继续执行"]
  const start = freshState(0, 3600)
  const first = step(obs({ inputValue: "", mono: 0, now: 0 }), start, cfg)
  assert.equal(first.action.type, "noop")
  const ready = step(obs({ inputValue: "", mono: 10 * 60_000, now: 10 * 60_000 }), first.state, cfg)
  assert.deepEqual(ready.action, { type: "idle-send", line: "继续执行" })
  const drafted = step(obs({ inputValue: "我的草稿", mono: 11 * 60_000, now: 11 * 60_000 }), first.state, cfg)
  assert.equal(drafted.action.type, "noop")
  const after = noteSend(ready.state, "sent", cfg, 11 * 60_000)
  assert.equal(after.idleIdx, 1)
  const held = noteSend(ready.state, "unclear", cfg, 11 * 60_000)
  assert.equal(held.idleIdx, 0)
})

test("click cooldown when the error line is still there", () => {
  const state = noteClickResult(freshState(0, 3600), true, true, 5_000)
  assert.equal(state.cooldownUntil, 25_000)
  const cfg = defaultConfig("en")
  const again = step(obs({
    now: 10_000,
    errorYs: [40],
    buttons: [retry(40)],
  }), state, cfg)
  assert.equal(again.action.type, "noop")
})

test("config json from the macOS app is accepted", () => {
  const cfg = configFromJson({
    version: 4,
    language: "zh",
    intervalSeconds: 15,
    durationChoice: "120",
    errorKeywords: ["At Capacity"],
    idleSendEnabled: true,
    scriptLines: ["继续"],
    limitPause: false,
  }, "en")
  assert.equal(cfg.lang, "zh")
  assert.equal(cfg.intervalSeconds, 15)
  assert.equal(cfg.durationSeconds, 7200)
  assert.deepEqual(cfg.errorKeywords, ["at capacity"])
  assert.equal(cfg.limitPause, false)
  assert.equal(cfg.idleSendEnabled, true)
})
