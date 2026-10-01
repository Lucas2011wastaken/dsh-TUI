#!/usr/bin/env node
/**
 * SIGCONT raw-mode restore regression (compiled lib).
 *
 * `Ctrl+Z` no longer suspends the app, so an EXTERNAL stop (`kill -STOP`, the
 * shell's `suspend`, SIGTSTP) is the only way to stop it — and while the job is
 * stopped the shell owns the tty and leaves it in its own COOKED modes. On
 * SIGCONT the app must put its own termios back, otherwise the composer keeps
 * drawing frames while the line discipline echoes every keystroke and delivers
 * nothing until Enter.
 *
 * Mounts the real tree over a fake TTY stdin whose `isRaw` flag the test
 * controls, then emits SIGCONT the way the kernel would.
 *
 * Run after build: `node scripts/verify-sigcont-rawmode.mjs`
 */
import { PassThrough, Writable } from 'node:stream'
import { settle, sleep } from './lib/term-test.mjs'

const [{ default: React }, { render }, { PromptInput }] = await Promise.all([
  import('react'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PromptInput.js'),
])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
stdout.columns = 100
stdout.rows = 30
stdout.isTTY = true
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
stderr.isTTY = true
const stdin = new PassThrough()
stdin.isTTY = true
stdin.isRaw = false
const rawCalls = []
stdin.setRawMode = mode => {
  rawCalls.push(mode)
  stdin.isRaw = mode
  return stdin
}
stdin.setEncoding = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit() {},
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
}

const instance = await render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand: () => false,
    selectionActive: false,
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)

try {
  await sleep(250) // 固定窗:pacing 等启动首帧（假 stdout 丢弃全部帧，无可 settle 的锚点）
  check('raw mode is enabled while the composer is mounted', rawCalls.includes(true) && stdin.isRaw === true,
    JSON.stringify(rawCalls))

  // The shell reset termios to its own cooked modes while the job was stopped.
  // `stdin.isRaw` is deliberately left alone: Node caches it as a plain stream
  // property, so after an external stop it still reads `true` while the tty is
  // cooked — that stale cache is exactly why the app must re-issue the ioctl
  // unconditionally instead of trusting the flag.
  rawCalls.length = 0
  process.emit('SIGCONT')
  await settle(() => rawCalls.includes(true))
  check('SIGCONT re-issues raw mode after an external stop', rawCalls.includes(true), JSON.stringify(rawCalls))

  // Every continue re-asserts termios (the ioctl is idempotent): the app cannot
  // tell a live raw mode from a stale cache.
  rawCalls.length = 0
  process.emit('SIGCONT')
  await settle(() => rawCalls.includes(true))
  check('a later SIGCONT re-asserts again', rawCalls.includes(true), JSON.stringify(rawCalls))

  instance.unmount()
  await sleep(120) // 固定窗:pacing 等 unmount 的清理落地（无单一可轮询锚点）
  rawCalls.length = 0
  process.emit('SIGCONT')
  await sleep(100) // 固定窗:探针 断言 unmount 后 SIGCONT 不得碰 tty：只能等观察窗
  check('SIGCONT after unmount does not touch the tty', rawCalls.length === 0, JSON.stringify(rawCalls))

  if (failed > 0) {
    console.error(`\n${failed} sigcont check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nverify-sigcont-rawmode OK')
  }
} finally {
  try { instance.unmount() } catch { /* already unmounted */ }
}
