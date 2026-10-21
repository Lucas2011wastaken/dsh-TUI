/**
 * verify-panel-overflow — issue #1664: the in-flow prompt panels (approval,
 * ask_user_question) sit in Chat's bottom chrome with `flexShrink: 0`, so
 * their height is their content height. Backend text rendered with an
 * unbounded `wrap` grew the panel past the viewport and the renderer clipped
 * the rows below the screen — which is exactly where the option rows and the
 * key hint live. The user saw a wall of command/question text and no button.
 *
 * This mounts the real Chat screen (fake channel + real ApprovalStore /
 * QuestionStore) in a 100×40 alternate screen — clipping, not scrollback —
 * and drives both panels with long payloads:
 *
 *   1. a short command: unchanged, no fold marker;
 *   2. a 300-line command: folded with a "N more lines" marker, and the
 *      question / option rows / key hint still on screen;
 *   3. a 40-line question: same invariant for the questionnaire panel;
 *   4. the same long command on a 24-row terminal: the panel shrinks its
 *      preview instead of pushing the tail off screen.
 *
 * Run: node --import tsx/esm scripts/verify-panel-overflow.tsx
 */
import './lib/default-lang-zh.mjs'
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { default: instances },
  { settle, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

/** Chat's channel seam, minimal: the transcript, the model and the cwd. */
const channel = {
  version: 0,
  rows: [
    { id: 0, kind: 'user', text: 'hello' },
    { id: 1, kind: 'assistant', text: 'hi there', time: Date.parse('2026-01-02T03:04:05Z') },
  ],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  turnStart: 0,
  lastUserText: 'hello',
  pending: [],
  commandList: [{ name: 'settings', description: 'open settings' }],
  notifications: [],
  subscribe: () => () => {},
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  commandCompletions: () => [],
  pushLocal: () => {},
  settingsHost: () => undefined,
  settingsSections: () => [],
  subscribeSettingsSections: () => () => {},
  runExternalCommand: () => Promise.resolve(undefined),
  listSessions: () => [],
  setResumeTarget: () => {},
} as never

const fakeApprovalReq = (callId: string, command: string) => ({
  agent: {
    id: 'probe',
    session: {
      events: [{
        type: 'tool/call',
        seq: 1,
        time: 0,
        data: { turn: 0, step: 0, callId, name: 'Bash', arguments: JSON.stringify({ command }) },
      }],
    },
  },
  toolName: 'Bash',
  callId,
  reason: 'verify probe',
}) as never

const longCommand = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n')
const longQuestion = Array.from({ length: 40 }, (_, index) => `问题第 ${index + 1} 行`).join('\n')

const questionReq = (question: string) => ({
  questions: [{
    id: 'q1',
    header: 'Overflow probe',
    question,
    options: [{ label: 'Option Alpha' }, { label: 'Option Beta' }],
  }],
}) as never

const rows = (): string[] => viewportLines(term, stdout.rows)
const screenText = (): string => rows().join('\n')
const visible = (text: string): boolean => rows().some(line => line.includes(text))

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log(detail.split('\n').map(line => `  |${line}`).join('\n'))
  }
}

/** The panel's interaction tail: the decision question, both option rows and
 *  the key hint. Whatever the preview does, these must be painted. */
const approvePanelVisible = (): boolean =>
  visible('要允许这次操作吗？') && visible('1. 允许（仅本次）') && visible('2. 拒绝') && visible('↑/↓ 选择')
const questionPanelVisible = (): boolean =>
  visible('Option Alpha') && visible('Option Beta') && visible('↑/↓ 选择')

const approvals = new ApprovalStore()
const questions = new QuestionStore()
// A real fullscreen session wraps Chat in <AlternateScreen>: its boxes are
// viewport-height, so the renderer clips instead of growing the frame into
// scrollback — exactly the layout the issue was reported in.
const tree = (): React.ReactElement => React.createElement(
  AlternateScreen,
  null,
  React.createElement(Chat, { channel, questionStore: questions, approvalStore: approvals }),
)
const app = await render(tree(), { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false })
// AlternateScreen resolves the instance via instances.get(process.stdout);
// the fake stream registers under its own key, so alias it and repaint.
const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {
  setAltScreenActive: (active: boolean, mouse: boolean) => void
}
instances.set(process.stdout, ink as never)
app.rerender(tree())
ink.setAltScreenActive(true, true)
await settle(() => visible('hello'), { timeoutMs: 5000 })

// 1) A short command renders as before: nothing folded.
{
  const parked = approvals.park(fakeApprovalReq('short', 'rm -rf /tmp/x\nls -la'))
  const shown = await settle(() => visible('要允许这次操作吗？'), { timeoutMs: 3000 })
  void shown
  check('short command: panel tail visible', approvePanelVisible(), screenText())
  check('short command: no fold marker', !visible('行未显示'), screenText())
  stdin.write('2')
  await parked
  await settle(() => !visible('要允许这次操作吗？'))
}

// 2) A 300-line command folds instead of flooding the screen.
{
  const parked = approvals.park(fakeApprovalReq('long', longCommand))
  await settle(() => visible('要允许这次操作吗？'), { timeoutMs: 3000 })
  const text = screenText()
  check('long command: panel tail visible', approvePanelVisible(), text)
  check('long command: folded with a marker', /… 另有 \d+ 行未显示/.test(text), text)
  check('long command: the tail is not painted', !text.includes('line 300'), text)
  stdin.write('2')
  await parked
  await settle(() => !visible('要允许这次操作吗？'))
}

// 3) The questionnaire panel keeps the same invariant.
{
  const asked = questions.ask(questionReq(longQuestion)).catch(() => undefined)
  await settle(() => visible('Option Alpha'), { timeoutMs: 3000 })
  const text = screenText()
  check('long question: panel tail visible', questionPanelVisible(), text)
  check('long question: folded with a marker', /… 另有 \d+ 行未显示/.test(text), text)
  check('long question: the tail is not painted', !text.includes('问题第 40 行'), text)
  stdin.write('\x1b')
  await asked
  await settle(() => !visible('Option Alpha'))
}

// 4) A short terminal shrinks the preview rather than the interaction tail.
{
  stdout.rows = 24
  term.resize(COLS, 24)
  stdout.emit('resize')
  await settle(() => rows().length === 24, { timeoutMs: 3000 })
  const parked = approvals.park(fakeApprovalReq('small', longCommand))
  await settle(() => visible('要允许这次操作吗？'), { timeoutMs: 3000 })
  check('24 rows: panel tail visible', approvePanelVisible(), screenText())
  stdin.write('2')
  await parked
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-panel-overflow: all checks passed')
process.exit(0)
