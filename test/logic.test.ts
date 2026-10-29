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
    stalled: false,
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

test("retry is chosen before scrolling", () => {
  const cfg = defaultConfig("zh")
  const result = step(obs({
    errorYs: [400],
    buttons: [retry(410), { label: "滚动到底部", y: 500, kind: "scroll" }],
  }), freshState(0, 3600), cfg)
  assert.equal(result.action.type, "click")
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

test("do not guess a single coordinate when several retry buttons are far apart", () => {
  const far = pickRetry([retry(10), retry(900)], [400])
  assert.equal(far, null)
  assert.equal(pickRetry([retry(900)], [10])?.y, 900)
})

test("still presses when several retry buttons belong to different sessions", () => {
  const cfg = defaultConfig("zh")
  const result = step(obs({
    errorYs: [400, -100000],
    buttons: [retry(10), retry(-100000)],
  }), freshState(0, 3600), cfg)
  assert.equal(result.action.type, "click")
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

test("a stalled goal is resumed even while stop is still showing", () => {
  const cfg = defaultConfig("zh")
  const result = step(obs({
    stalled: true,
    errorYs: [400],
    buttons: [
      { label: "停止", y: 900, kind: "busy" },
      { label: "滚动到底部", y: 800, kind: "scroll" },
      { label: "恢复目标", y: 850, kind: "resume" },
    ],
  }), freshState(0, 3600), cfg)
  assert.equal(result.action.type, "resume")
  assert.match(result.logs.join("\n"), /恢复已停滞的目标/)
  assert.equal(classifyLabel("恢复目标"), "resume")
  assert.equal(classifyLabel("Resume goal"), "resume")
  assert.equal(classifyLabel("清除目标"), "other")
})

test("resume waits out typing and the click cooldown", () => {
  const cfg = defaultConfig("zh")
  const typing = step(obs({
    stalled: true,
    userActive: true,
    errorYs: [40],
    buttons: [{ label: "恢复目标", y: 1, kind: "resume" }],
  }), freshState(0, 3600), cfg)
  assert.equal(typing.action.type, "noop")
  const cooled = freshState(0, 3600)
  cooled.cooldownUntil = 30_000
  const waiting = step(obs({
    now: 10_000,
    stalled: true,
    errorYs: [40],
    buttons: [{ label: "恢复目标", y: 1, kind: "resume" }],
  }), cooled, cfg)
  assert.equal(waiting.action.type, "noop")
})

test("default run keeps listening with no deadline and no idle stop", () => {
  const cfg = defaultConfig("zh")
  assert.equal(cfg.durationSeconds, 0)
  assert.equal(cfg.idleStop, false)
  const state = freshState(0, cfg.durationSeconds)
  assert.equal(state.deadline, Number.POSITIVE_INFINITY)
  const later = step(obs({ now: 24 * 3600_000, mono: 24 * 3600_000 }), state, cfg)
  assert.equal(later.action.type, "noop")
  assert.equal(later.state.running, true)
})

test("a finite duration still stops at the deadline", () => {
  const cfg = defaultConfig("zh")
  const state = freshState(0, 30 * 60)
  const result = step(obs({ now: 30 * 60_000, mono: 30 * 60_000 }), state, cfg)
  assert.equal(result.action.type, "stop")
  assert.match(result.logs.join("\n"), /已到设定时长/)
})

test("idle stop still ends a quiet run when enabled", () => {
  const cfg = defaultConfig("zh")
  cfg.idleStop = true
  const state = freshState(0, 3600)
  const result = step(obs({ now: 601_000, mono: 601_000 }), state, cfg)
  assert.equal(result.action.type, "stop")
  assert.match(result.logs.join("\n"), /自动停止/)
})

test("durationSeconds 0 in config means permanent listening", () => {
  const cfg = configFromJson({ durationSeconds: 0, durationChoice: "30" }, "zh")
  assert.equal(cfg.durationSeconds, 0)
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
