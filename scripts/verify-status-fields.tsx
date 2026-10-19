/**
 * Plugin footer fields (`tuiStatus.setField`) — admission half.
 *
 * Runs against a real Cordis composition: the returned disposer, option
 * normalization, every refusal path (key/text/tone/slot/maxCells/minColumns/
 * onClick-without-detail), token semantics, activation ownership, caps
 * (6 total / 2 per activation), effect cleanup on fiber dispose, bidi
 * stripping, and effect-ledger records with kind `status-field`.
 *
 * The rendering half (zero footprint, the three slots, hover detail, click
 * dispatch) lands with the StatusLine wiring and extends this battery.
 *
 * Run: node --import tsx/esm scripts/verify-status-fields.tsx
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME/USERPROFILE must be isolated before any src import (paths.ts captures
// DATA_DIR at module load).
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-status-fields-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
// Colour on: the tone cases assert themed cells, and the zero-footprint case
// compares real frames rather than plain text.
process.env.FORCE_COLOR = '3'

const [
  { Context },
  statusModule,
  ledgerModule,
  { stringWidth },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/status.js'),
  import('../src/dsh-adapter/effect-ledger.js'),
  import('../src/ink/stringWidth.js'),
])

const { TuiStatusRuntime, getHostStatusStore } = statusModule
const { TuiEffectLedgerRuntime } = ledgerModule

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

// ── Part A: admission ───────────────────────────────────────────────────────

const ledgerFile = join(fakeHome, 'ledger.jsonl')
const root = new Context()
const warnings: string[] = []
root.logger.exporter({
  colors: false,
  levels: { default: 4 },
  export(message: { type: string; args: unknown[] }): void {
    if (message.type === 'warn') {
      warnings.push(message.args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
    }
  },
})
new TuiEffectLedgerRuntime(root, { file: ledgerFile, generationId: 'status-fields-battery' })
await root.plugin(TuiStatusRuntime)

const store = getHostStatusStore(root.get('tuiStatus'))
if (store === undefined) throw new Error('status store accessor unavailable')
const fieldOf = (key: string) => store.getFieldSnapshot().find(field => field.key === key)
const warnCount = () => warnings.length
/** One persisted ledger record, narrowed to the fields this battery reads. */
interface LedgerRecord {
  operation?: string
  resource?: { kind?: string; id?: string }
}
const ledgerRecords = (): LedgerRecord[] =>
  readFileSync(ledgerFile, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as LedgerRecord)

/** Mount one plugin activation; the callback runs inside its fiber. */
async function activate(run: (ctx: Context) => void) {
  const fiber = root.inject(['tuiStatus', 'tuiEffectLedger'], (pluginCtx: Context) => {
    run(pluginCtx)
  })
  await fiber
  return fiber
}

/** Every refusal must warn and leave the store untouched, never throw. */
async function refused(name: string, run: (ctx: Context) => void): Promise<void> {
  const before = warnCount()
  const beforeFields = store.getFieldSnapshot().length
  let threw: unknown
  const fiber = await activate(ctx => {
    try {
      run(ctx)
    } catch (error) {
      threw = error
    }
  })
  check(`${name}: refused without throwing`, threw === undefined, String(threw))
  check(`${name}: warned`, warnCount() > before)
  check(`${name}: no field entered the store`, store.getFieldSnapshot().length === beforeFields)
  await fiber.dispose()
}

// A1 — admitted field, normalized entry, disposer.
{
  store.clear()
  let dispose: (() => void) | undefined
  const fiber = await activate(ctx => {
    dispose = ctx.tuiStatus.setField('build', '构建 42%', {
      slot: 'right-head',
      tone: 'success',
      maxCells: 20,
      minColumns: 100,
      detail: 'watch #42',
      onClick: () => {},
    })
  })
  const entry = fieldOf('build')
  check('A1 entry carries normalized options',
    entry !== undefined
    && entry.text === '构建 42%'
    && entry.slot === 'right-head'
    && entry.tone === 'success'
    && entry.maxCells === 20
    && entry.minColumns === 100
    && entry.detail === 'watch #42'
    && typeof entry.onClick === 'function',
    JSON.stringify(entry))
  check('A1 disposer is a function', typeof dispose === 'function')
  dispose?.()
  check('A1 disposer clears its own field', fieldOf('build') === undefined)
  await fiber.dispose()
}

// A2 — invalid key, text, and options.
{
  store.clear()
  await refused('A2 invalid key', ctx => ctx.tuiStatus.setField('Bad Key', 'x'))
  await refused('A2 non-scalar text', ctx => ctx.tuiStatus.setField('obj', { nope: true }))
  await refused('A2 invalid tone', ctx => ctx.tuiStatus.setField('tone', 'x', { tone: 'rainbow' }))
  await refused('A2 invalid slot', ctx => ctx.tuiStatus.setField('slot', 'x', { slot: 'middle' }))
  await refused('A2 fractional maxCells', ctx => ctx.tuiStatus.setField('cells', 'x', { maxCells: 1.5 }))
  await refused('A2 string maxCells', ctx => ctx.tuiStatus.setField('cells2', 'x', { maxCells: '20' }))
  await refused('A2 fractional minColumns', ctx => ctx.tuiStatus.setField('cols', 'x', { minColumns: 1.5 }))
  await refused('A2 non-object options', ctx => ctx.tuiStatus.setField('opts', 'x', null))
  await refused('A2 non-string detail', ctx => ctx.tuiStatus.setField('detail', 'x', { detail: 42 }))
}

// A3 — cell-accurate truncation for wide and combining text.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('cjk', '构建构建构建构建构建', { maxCells: 8 })
    ctx.tuiStatus.setField('emoji', '🙂🙂🙂🙂🙂🙂🙂', { maxCells: 5 })
  })
  const cjk = fieldOf('cjk')
  const emoji = fieldOf('emoji')
  check('A3 CJK text capped in cells with an ellipsis',
    cjk !== undefined && stringWidth(cjk.text) <= 8 && cjk.text.endsWith('…'),
    `${JSON.stringify(cjk?.text)} width=${cjk === undefined ? 'n/a' : stringWidth(cjk.text)}`)
  check('A3 emoji text capped in cells with an ellipsis',
    emoji !== undefined && stringWidth(emoji.text) <= 5 && emoji.text.endsWith('…'),
    `${JSON.stringify(emoji?.text)} width=${emoji === undefined ? 'n/a' : stringWidth(emoji.text)}`)
  await fiber.dispose()
}

// A4 — maxCells clamps to [1, 32] and defaults to 16.
{
  store.clear()
  let high = 0
  let low = 0
  let def = 0
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('clamp', 'x', { maxCells: 999 })
    high = fieldOf('clamp')?.maxCells ?? -1
    ctx.tuiStatus.setField('clamp', undefined)
    ctx.tuiStatus.setField('clamp', 'x', { maxCells: 0 })
    low = fieldOf('clamp')?.maxCells ?? -1
    ctx.tuiStatus.setField('clamp', undefined)
    ctx.tuiStatus.setField('clamp', 'x')
    def = fieldOf('clamp')?.maxCells ?? -1
  })
  check('A4 maxCells clamps to 32 / 1, defaults to 16', high === 32 && low === 1 && def === 16, `${high}/${low}/${def}`)
  await fiber.dispose()
}

// A5 — a clickable field owes a detail line; clearing the detail retracts it.
{
  store.clear()
  await refused('A5 onClick without detail', ctx => {
    ctx.tuiStatus.setField('click', 'x', { onClick: () => {} })
  })
  let fiber = await activate(ctx => {
    ctx.tuiStatus.setField('click', 'CLICK', { detail: 'why', onClick: () => {} })
  })
  check('A5 onClick with detail is admitted', typeof fieldOf('click')?.onClick === 'function')
  await refused('A5 clearing detail while a click survives', ctx => {
    ctx.tuiStatus.setField('click', 'CLICK', { detail: '' })
  })
  check('A5 the refused update kept the original detail', fieldOf('click')?.detail === 'why')
  await fiber.dispose()
}

// A6 — a throwing click is logged/reported once and never escapes.
{
  store.clear()
  let handledKey: string | undefined
  let handledMessage: string | undefined
  store.setFieldErrorHandler((key, error) => {
    handledKey = key
    handledMessage = error.message
  })
  let click: (() => void) | undefined
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('boom', 'BOOM', { detail: 'Boom detail', onClick: () => { throw new Error('kaboom') } })
    click = fieldOf('boom')?.onClick
  })
  let escaped: unknown
  try {
    click?.()
  } catch (error) {
    escaped = error
  }
  check('A6 click error is swallowed', escaped === undefined, String(escaped))
  check('A6 error handler sees the key and the error once', handledKey === 'boom' && handledMessage === 'kaboom',
    `${handledKey}/${handledMessage}`)
  store.setFieldErrorHandler(undefined)
  await fiber.dispose()
}

// A7 — another activation can neither update nor clear an owned field.
{
  store.clear()
  const first = await activate(ctx => {
    ctx.tuiStatus.setField('owned', 'mine')
  })
  const second = await activate(ctx => {
    ctx.tuiStatus.setField('owned', 'theirs')
    ctx.tuiStatus.setField('owned', undefined)
  })
  check('A7 foreign update/clear is refused, original survives', fieldOf('owned')?.text === 'mine')
  await second.dispose()
  await first.dispose()
}

// A8 — an old disposer must not clear a newer write (token, not text).
{
  store.clear()
  let oldDispose: (() => void) | undefined
  const fiber = await activate(ctx => {
    oldDispose = ctx.tuiStatus.setField('token', 'first')
    ctx.tuiStatus.setField('token', 'second')
  })
  oldDispose?.()
  check('A8 stale disposer leaves the newer value intact', fieldOf('token')?.text === 'second')
  await fiber.dispose()
}

// A9 — ctx.effect cleanup on plugin dispose, and a reload re-admits the key.
{
  store.clear()
  const first = await activate(ctx => {
    const dispose = ctx.tuiStatus.setField('reload', 'v1')
    ctx.effect(() => () => dispose())
  })
  check('A9 field is visible before dispose', fieldOf('reload')?.text === 'v1')
  await first.dispose()
  check('A9 fiber dispose removes the field', fieldOf('reload') === undefined)
  const second = await activate(ctx => {
    ctx.tuiStatus.setField('reload', 'v2')
  })
  check('A9 reloaded activation re-admits the same key', fieldOf('reload')?.text === 'v2')
  await second.dispose()
}

// A10 — the composition root is not a plugin activation.
{
  store.clear()
  let threw: unknown
  try {
    root.get('tuiStatus')?.setField('root-leak', 'x')
  } catch (error) {
    threw = error
  }
  check('A10 root call is refused without throwing', threw === undefined, String(threw))
  check('A10 root call leaves no field', fieldOf('root-leak') === undefined)
}

// A11 — two per activation, six in total.
{
  store.clear()
  const before = warnCount()
  const single = await activate(ctx => {
    ctx.tuiStatus.setField('one', '1')
    ctx.tuiStatus.setField('two', '2')
    ctx.tuiStatus.setField('three', '3')
  })
  check('A11 third field from one activation is refused', store.getFieldSnapshot().length === 2 && warnCount() > before)
  await single.dispose()

  store.clear()
  const fibers = []
  for (let index = 0; index < 3; index += 1) {
    fibers.push(await activate(ctx => {
      ctx.tuiStatus.setField(`p${index}-a`, 'a')
      ctx.tuiStatus.setField(`p${index}-b`, 'b')
    }))
  }
  check('A11 six fields from three activations are admitted', store.getFieldSnapshot().length === 6)
  const beforeSeventh = warnCount()
  const fourth = await activate(ctx => {
    ctx.tuiStatus.setField('seventh', '7')
  })
  check('A11 seventh field is refused', store.getFieldSnapshot().length === 6 && warnCount() > beforeSeventh)
  await fourth.dispose()
  for (const fiber of fibers) await fiber.dispose()
}

// A12 — the effect ledger records bind / replace / release with kind status-field.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('ledger-x', 'one', {}, ctx)
    ctx.tuiStatus.setField('ledger-x', 'two', {}, ctx)
  })
  // Dispose the explicit first write: the second one still owns the key.
  await fiber.dispose()
  const records = ledgerRecords().filter(record => record.resource?.id === 'ledger-x')
  const ops = records.map(record => record.operation)
  check('A12 ledger records bind + replace', ops.includes('bind') && ops.includes('replace'), ops.join(','))
  check('A12 ledger records release on dispose', ops.includes('release'), ops.join(','))
  check('A12 ledger kind is status-field', records.every(record => record.resource?.kind === 'status-field'))
}

// A13 — bidi overrides and zero-width marks never reach a footer cell.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('bidi', 'ab\u202Ecd\u200Bef', { detail: 'x\u202Ey\uFEFF' })
  })
  check('A13 bidi/zero-width stripped from text', fieldOf('bidi')?.text === 'abcdef', JSON.stringify(fieldOf('bidi')?.text))
  check('A13 bidi/zero-width stripped from detail', fieldOf('bidi')?.detail === 'xy', JSON.stringify(fieldOf('bidi')?.detail))
  await fiber.dispose()
}

await root.fiber.dispose()
console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`)
process.exit(failures === 0 ? 0 : 1)
