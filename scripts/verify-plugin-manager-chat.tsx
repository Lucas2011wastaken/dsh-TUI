/**
 * `/plugin` in real Chat (Stage C-3): the diagnostics half, the profile's
 * bundles and rows from the host plugin service, gate 1's tag, `info`,
 * `registries`, the removed old name, and what happens when the service is
 * absent or refuses every call.
 *
 * The service is a fake: nothing here installs, removes, or enables anything.
 * The declared-and-supported branch of the tag goes through the same
 * parse/validate/negotiate path `check <path>` uses, which
 * `verify-plugin-negotiation` already exercises against real fixtures and a
 * live host descriptor.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-manager-chat.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { BundleInfo, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'

const [{ Writable, PassThrough }, { mkdtempSync }, { tmpdir }, { join }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { pluginReport }, { kernelEntriesOf }, { listBackends }, { findText, settle, settled, sleep, viewportLines }, { Context }] = await Promise.all([
  import('node:stream'),
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/plugins-info.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/dsh-adapter/backend-registry.js'),
  import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'),
])

setLang('en')
const ROWS = 40

const bundles: BundleInfo[] = [
  {
    // The installation's own base layer, in the shape a real profile reports:
    // supplied by the installation (`installed: false`) and named by no shipped
    // template's `OPTIONAL_BUNDLES` (`optional: false`) — so the overview's
    // groups must key on `installed`, or this row lands under "Profile
    // dependencies".
    name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', enabled: true, installed: false,
    optional: false, removable: false, rows: [], overrides: ['hmr'],
  },
  {
    name: '@deepseek-harness-tui/dsh-tui', version: '0.14.0', enabled: true, installed: true,
    optional: false, removable: true, rows: [{ rowId: 'tui-row', moduleName: '@deepseek-harness-tui/dsh-tui' }], overrides: [],
  },
  {
    name: 'verify-plugin-undeclared', version: '3.1.4', enabled: false, installed: true,
    optional: false, removable: true, rows: [], overrides: [],
  },
  {
    name: 'verify-plugin-locked', version: '4.0.0', enabled: true, installed: true, optional: false,
    removable: false, readOnlyReason: 'management-required', error: { code: 'bundle-in-use', diagnostic: 'held by 2 rows' },
    rows: [], overrides: [],
  },
]
const plugins: PluginInfo[] = [
  { entryId: 'entry-live' as PluginEntryId, moduleName: '@deepseek-ai/dsh-base', enabled: true, fiberPhase: 'active', patchId: 'row-base' },
  {
    entryId: 'entry-orphan' as PluginEntryId, moduleName: 'orphan-row', enabled: false, fiberPhase: 'pending',
    readOnlyReason: 'unaddressable', meta: { title: { en: 'Orphan row', zh: '孤儿行' } },
  },
]
/** What an npm/pnpm configuration may embed in a registry URL's userinfo: the
 *  report is a transcript, so this must never reach the screen. */
const CREDENTIAL = 'tok3n-s3cret'
const CREDENTIAL_URL = `https://reader:${CREDENTIAL}@registry.npmjs.org/`
/** The same secret in the two shapes the upstream hands back beyond a URL
 *  field: a spec a person typed (the report falls back to it when the upstream
 *  leaves a git URL unnamed) and a URL quoted inside free text. */
const SPEC_CREDENTIAL = 'fake-review-credential'
const SPEC_CREDENTIAL_URL = `https://reader:${SPEC_CREDENTIAL}@git.example.com/org/repo.git`

const manager: PluginManagerView = {
  listBundles: () => Promise.resolve(bundles),
  listPlugins: () => Promise.resolve(plugins),
  registries: () => Promise.resolve({
    registry: CREDENTIAL_URL,
    fallbackRegistries: [`https://reader:${CREDENTIAL}@registry.npmmirror.com/`],
    resolved: null,
  }),
  inspect: spec => Promise.resolve(spec === 'verify-bad-spec'
    ? { status: 'refused', problem: 'not-found', reason: '404 Not Found' }
    // A git spec the upstream accepts without naming it: the report falls back
    // to the spec itself, which is exactly the line that must not carry it.
    : spec === SPEC_CREDENTIAL_URL
      ? { status: 'accepted', kind: 'git', bundle: true, registry: null }
      : {
          status: 'accepted', kind: 'registry', name: 'verify-fresh-plugin', version: '9.9.9',
          description: 'a fresh plugin', bundle: true, registry: CREDENTIAL_URL,
          host: `https://reader:${CREDENTIAL}@git.example.com/repo.git`,
        }),
}

/** The same service, refusing every call: the report must survive it. */
const SERVICE_FAILURE = 'the plugin service is gone'
const failingManager: PluginManagerView = {
  listBundles: () => Promise.reject(new Error(SERVICE_FAILURE)),
  listPlugins: () => Promise.reject(new Error(SERVICE_FAILURE)),
  registries: () => Promise.reject(new Error(SERVICE_FAILURE)),
  inspect: () => Promise.reject(new Error(SERVICE_FAILURE)),
}

/** The same service, throwing BEFORE it returns a promise: `.catch` cannot see
 *  that, so every consumer has to contain it on its own. */
const SYNC_FAILURE = 'the plugin service threw before answering'
const syncThrowManager: PluginManagerView = {
  ...manager,
  listBundles: () => { throw new Error(SYNC_FAILURE) },
}

/** Only the installation-supplied bundle: the "nothing added yet" profile. */
const officialOnlyManager: PluginManagerView = {
  ...manager,
  listBundles: () => Promise.resolve(bundles.filter(bundle => !bundle.installed)),
}

/** The service each form mounts (`absent` mounts none). */
const SERVICES: Record<string, PluginManagerView | undefined> = {
  present: manager,
  'official-only': officialOnlyManager,
  absent: undefined,
  failing: failingManager,
  'sync-throw': syncThrowManager,
}

/** Drain the microtask queue: the report's async chain holds no timers, so one
 *  macrotask boundary sees it finished. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** The agent fixture a real channel binds as its startup session. */
function makeAgent(id: string, sessionId: string) {
  return {
    id, status: 'idle',
    session: { id: sessionId, seq: 0, events: [], header: {} },
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, inbox: { remove: () => true },
  }
}

/** One terminal + Chat rig: stdin → React → throttled render → xterm. Both the
 *  forms loop below and the session-fence case drive this same pipeline. */
function makeHarness(columns: number, fullscreen: boolean) {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new In()
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  const hasText = (text: string): boolean => screen().replaceAll(/\s+/gu, '').includes(text.replaceAll(/\s+/gu, ''))
  const type = async (line: string): Promise<void> => {
    for (const char of line) stdin.write(char)
    // 固定窗:pacing the prompt applies typed characters on its own render tick.
    await sleep(60)
  }
  const run = async (line: string): Promise<void> => {
    await type(line)
    stdin.write('\r')
  }
  const clear = async (): Promise<void> => {
    for (let index = 0; index < 40; index += 1) stdin.write('\x7f')
    // 固定窗:pacing backspaces land before the next keystroke batch.
    await sleep(60)
  }
  const above = (first: string, second: string): boolean => {
    const one = findText(term, first)
    const two = findText(term, second)
    return one !== null && two !== null && one.row < two.row
  }
  const render = (node: React.ReactElement): Promise<{ unmount(): void }> => ui.render(
    fullscreen ? <ui.AlternateScreen mouseTracking>{node}</ui.AlternateScreen> : node,
    {
      stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never,
      exitOnCtrlC: false, patchConsole: false,
    },
  )
  return { term, stdin, screen, hasText, type, run, clear, above, render }
}

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

for (const [fullscreen, columns, service] of [
  [false, 100, 'present'],
  [false, 50, 'present'],
  [true, 100, 'present'],
  [false, 100, 'official-only'],
  [false, 100, 'absent'],
  [false, 100, 'failing'],
  [false, 100, 'sync-throw'],
] as const) {
  const tag = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}${service === 'present' ? '' : ` ${service}`}`
  const { term, stdin, screen, hasText, type, run, clear, above, render } = makeHarness(columns, fullscreen)
  const ctx = {
    on: () => () => undefined,
    get: (name: string) => name === 'pluginManager' ? SERVICES[service] : undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never
  // `/plugin` is a DSH-served command (its requirement defaults to `dsh`), so
  // the fixture is an Agent: createChannel builds the real DSH session around
  // it and attaches the DSH extensions this command lives in.
  const channel = createChannel(ctx, makeAgent('plugin-chat', 's-plugin-chat') as never, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false })
  const instance = await render(React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen, trajectorySeen: true,
    kernelEntries: kernelEntriesOf(listBackends()),
  }))

  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)

    if (service === 'official-only') {
      await run('/plugin list')
      check(`${tag}: a profile with nothing added says so`,
        await settled(() => hasText(t('plugins-list-empty'))), screen())
      await clear()
      continue
    }
    if (service === 'sync-throw') {
      // The service throws before it hands back a promise, which `.catch`
      // cannot see: the completion tree must fall back to its static forms
      // instead of taking the keystroke path down with the raw throw.
      await type('/plugin ')
      check(`${tag}: a synchronously throwing service leaves the static forms`,
        await settled(() => hasText('plugin list') && hasText('plugin registries')), screen())
      await clear()
    }
    if (service === 'present') {
      // `list` runs first: it is the only form that asserts an ABSENCE (the
      // installation's own bundles), and the transcript keeps every earlier
      // report's lines on screen.
      await run('/plugin list')
      // Settle on the block's tail, then assert the exclusion FIRST: it is the
      // reason `list` exists, and it is the assertion a wrong predicate must
      // break before the header count hides it.
      check(`${tag}: list answers`,
        await settled(() => hasText('/plugin info') && hasText('/plugin registries')), screen())
      check(`${tag}: list leaves the installation's own bundles out`,
        !hasText('@deepseek-ai/dsh-base') && !hasText('@deepseek-harness-tui/dsh-tui'), screen())
      check(`${tag}: list names the plugins the person added`,
        hasText(`verify-plugin-undeclared 3.1.4 · off · ${t('plugins-tag-undeclared')}`) &&
        hasText('verify-plugin-locked 4.0.0 · on · not removable'), screen())
      check(`${tag}: list leads with the trust banner`,
        above('C-070', t('plugins-list-header', { count: '2' })), screen())
      check(`${tag}: list points at the detail forms`,
        hasText('/plugin info') && hasText('/plugin registries'), screen())
      await clear()

      // The completion tree: the static subcommand hints first, then whatever
      // names the service holds. The popup shows the path WITHOUT a leading
      // slash and the composer with one, so the Tab assertion below reads the
      // composer alone.
      await type('/plugin ')
      check(`${tag}: the popup offers the list and registries forms`,
        await settled(() => hasText('plugin list') && hasText('plugin registries')), screen())
      if (columns >= 100) {
        check(`${tag}: the popup describes the forms`,
          hasText(t('sugg-plugin-list-desc')) && hasText(t('sugg-plugin-registries-desc')), screen())
      }
      await type('info ')
      check(`${tag}: info completes the names the profile added`,
        await settled(() => hasText('plugin info verify-plugin-undeclared')), screen())
      check(`${tag}: the popup leaves the installation's own bundles out`,
        !hasText('@deepseek-ai/dsh-base'), screen())
      stdin.write('\t')
      check(`${tag}: Tab accepts the completed name into the composer`,
        await settled(() => hasText('/plugin info verify-plugin-undeclared')), screen())
      await clear()
    }

    await run('/plugin')
    if (service === 'failing' || service === 'sync-throw') {
      // The service fails: the diagnostics half is intact and the failure is
      // one line of its own, not a lost report (and not an unhandled rejection
      // — nor, for the synchronous throw, an escaped one).
      const failure = service === 'failing' ? SERVICE_FAILURE : SYNC_FAILURE
      check(`${tag}: a failing service keeps the diagnostics and reports itself`,
        await settled(() => hasText(t('plugins-host-unavailable')) &&
          hasText(t('plugins-service-error', { err: failure }))), screen())
      await clear()
      continue
    }
    // Land on a marker at the END of the report: in a narrow viewport the
    // diagnostics half wraps past what the screen can hold, so the block's own
    // tail is the only anchor that is always on screen.
    check(`${tag}: the overview answers`,
      await settled(() => hasText('Orphan row') || hasText('ctx.pluginManager')), screen())
    if (service === 'absent') {
      check(`${tag}: absent service keeps the diagnostics and explains itself`,
        hasText(t('plugins-matrix-note')) && hasText('ctx.pluginManager'), screen())
      continue
    }
    if (columns >= 100) {
      check(`${tag}: the trust banner stays the first line`, above('C-070', 'Installed bundles'), screen())
      // The installation's own base layer is `installed: false, optional: false`
      // — keyed on `optional` it would land under "Profile dependencies", below
      // that label instead of above it.
      check(`${tag}: an installation-supplied bundle sits under the official group`,
        above('@deepseek-ai/dsh-base 0.2.0-rc.2', 'Profile dependencies'), screen())
    }
    check(`${tag}: official bundles precede the profile's own`,
      above('Official', 'Profile dependencies'), screen())
    check(`${tag}: an undeclared third-party row carries gate 1's tag`,
      hasText(`verify-plugin-undeclared 3.1.4 · off · ${t('plugins-tag-undeclared')}`), screen())
    check(`${tag}: the composition's own rows carry no tag`,
      hasText('@deepseek-ai/dsh-base 0.2.0-rc.2 · on · not removable · rows 0 / overrides 1') &&
      hasText('@deepseek-harness-tui/dsh-tui 0.14.0 · on · rows 1 / overrides 0'), screen())
    check(`${tag}: locked and problem states render verbatim`,
      hasText(`verify-plugin-locked 4.0.0 · on · not removable · ${t('plugins-bundle-locked', { reason: 'management-required' })} · ${t('plugins-bundle-problem', { code: 'bundle-in-use' })}`), screen())
    check(`${tag}: an unaddressable loader entry is listed separately`,
      hasText(t('plugins-rows-header')) && hasText('Orphan row'), screen())
    check(`${tag}: the tag is explained once, in the legend`,
      hasText('the package ships no package-root dsh-plugin.json'), screen())
    await clear()

    await run('/plugin info verify-plugin-locked')
    check(`${tag}: info describes an installed bundle`,
      await settled(() => hasText(t('plugins-info-bundle', { name: 'verify-plugin-locked' }))), screen())
    check(`${tag}: info repeats the problem with its diagnostic`,
      hasText(`${t('plugins-bundle-problem', { code: 'bundle-in-use' })} — held by`), screen())
    await clear()

    await run('/plugin info verify-fresh-plugin')
    check(`${tag}: info inspects a spec that is not installed`,
      await settled(() => hasText('Installable: verify-fresh-plugin 9.9.9 · registry · bundle=true')), screen())
    check(`${tag}: the inspection keeps its description`, hasText('a fresh plugin'), screen())
    check(`${tag}: the inspection shows its registry and host without credentials`,
      !hasText(CREDENTIAL) && hasText('registry.npmjs.org') && hasText('git.example.com'), screen())
    await clear()

    await run('/plugin info verify-bad-spec')
    check(`${tag}: a refused spec reports its problem and reason`,
      await settled(() => hasText('Not installable: not-found — 404 Not Found')), screen())
    await clear()

    await run('/plugin registries')
    check(`${tag}: registries lists the first and its fallbacks`,
      await settled(() => hasText('registry.npmjs.org') && hasText('registry.npmmirror.com')), screen())
    check(`${tag}: an unreadable pnpm resolution is reported as none`,
      hasText(t('plugins-info-registries-resolved', { registry: t('plugins-info-registries-none') })), screen())
    check(`${tag}: the registries keep their names but never their credentials`,
      !hasText(CREDENTIAL) && hasText('registry.npmjs.org') && hasText('registry.npmmirror.com'), screen())
    await clear()

    // The spec itself: the upstream accepts a git URL without naming it, so the
    // report falls back to what the person typed. That line is a transcript
    // line like any other — it keeps host and path and never the userinfo.
    await run(`/plugin info ${SPEC_CREDENTIAL_URL}`)
    check(`${tag}: info redacts the credentials of the spec it was handed`,
      await settled(() => hasText('Installable: https://git.example.com/org/repo.git')) &&
      !hasText(SPEC_CREDENTIAL), screen())
    await clear()

    // The rename shipped without a deprecation cycle: nothing was released
    // under the old name, so the merged catalog — the list dispatch and the
    // root completion both match `name` against — must no longer carry it.
    // (A screen-level absence check would read the transcript, which still
    // holds the previous report's lines.)
    check(`${tag}: the removed old name is not a command`,
      !channel.commandList.some(command => command.name === 'plugins'), channel.commandList.map(command => command.name).join(','))
    await clear()

    await run('/plugin bogus')
    check(`${tag}: an unknown subcommand names every supported form`,
      await settled(() => hasText('Unknown subcommand: bogus') && hasText('registries')), screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}

// ── Every credential-bearing path of the report, without a terminal ─────────
// Four ways a secret reaches `pluginReport`, three of which are TEXT rather
// than a URL field: an accepted spec the upstream left unnamed (the report
// falls back to the raw spec), a refusal reason, a thrown error — plus registry
// fields whose credential is a query parameter and needs no userinfo at all.
// The report is a transcript, so each of them keeps host and path and loses the
// secret. `deps` points at an empty directory: this block reads no user state.
{
  const probeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-redaction-'))
  const deps = {
    grants: { knownPermissions: () => [], allows: () => false },
    dataDir: probeHome,
    ledgerFile: join(probeHome, 'ledger.jsonl'),
    storageDir: probeHome,
  }
  const inspectOf = (inspection: unknown): PluginManagerView => ({ ...manager, inspect: () => Promise.resolve(inspection as never) })
  const spec = SPEC_CREDENTIAL_URL
  const paths: readonly [string, PluginManagerView, string][] = [
    ['an accepted spec the upstream left unnamed', inspectOf({ status: 'accepted', kind: 'git', bundle: true, registry: null }), spec],
    ['a refusal reason quoting it', inspectOf({ status: 'refused', problem: 'network', reason: `Failed to fetch ${spec}` }), 'probe-plugin'],
    ['an exception message quoting it', { ...manager, inspect: () => { throw new Error(`Cannot reach ${spec}`) } }, 'probe-plugin'],
  ]
  for (const [label, service, arg] of paths) {
    const lines = await pluginReport(`info ${arg}`, deps as never, service)
    check(`report: ${label} keeps host and path, never the credential`,
      !lines.some(line => line.includes(SPEC_CREDENTIAL)) &&
      lines.some(line => line.includes('git.example.com/org/repo.git')),
      lines.join('\n'))
  }
  const query = (host: string, key: string): string => `https://${host}/?${key}=${SPEC_CREDENTIAL}`
  const registries = await pluginReport('registries', deps as never, {
    ...manager,
    registries: () => Promise.resolve({
      registry: query('registry.example.com', 'token'),
      fallbackRegistries: [query('npm.example.com', 'access_token')],
      resolved: `https://other.example.com/path?_authToken=${SPEC_CREDENTIAL}`,
    }),
  })
  check('report: a query-only token keeps host and path, never the credential',
    !registries.some(line => line.includes(SPEC_CREDENTIAL)) &&
    ['registry.example.com', 'npm.example.com', 'other.example.com/path']
      .every(host => registries.some(line => line.includes(host))),
    registries.join('\n'))
}
// ── Both async reports are fenced to the session that asked for them ───────
// `pluginsInfo` (async since C-3) and `listSubagents` answer through `pushLocal`,
// which writes whichever session is bound NOW: a report that lands after a
// `/new` or a resume would appear in the new session's transcript without the
// generation guard in Chat.
{
  const tag = 'session fence'
  const { term, stdin, screen, type, run, render } = makeHarness(100, false)
  /** A service call the test can park and then release. */
  interface Gate<T> {
    setHold(on: boolean): void
    call(): Promise<T>
    readonly waiting: number
    releaseAll(): void
  }
  function makeGate<T>(answer: T): Gate<T> {
    let hold = false
    const parked: Array<(value: T) => void> = []
    return {
      setHold: (on: boolean): void => { hold = on },
      call: (): Promise<T> => hold ? new Promise<T>(resolve => { parked.push(resolve) }) : Promise.resolve(answer),
      get waiting(): number { return parked.length },
      /** Release every parked answer — the report's is among them. */
      releaseAll: (): void => { while (parked.length > 0) parked.pop()?.(answer) },
    }
  }
  const bundleGate = makeGate(bundles)
  const childGate = makeGate([] as Array<{ mode: string; label?: string; activity: string; id: string }>)
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const slowManager: PluginManagerView = { ...manager, listBundles: bundleGate.call }
  provide('pluginManager', slowManager)
  provide('subagents', { listChildren: childGate.call })
  // `/new` needs the agents service; each handle's agent becomes the new session.
  let created = 0
  provide('agents', {
    get: () => undefined,
    create: () => {
      created += 1
      return Promise.resolve({
        agent: { ...makeAgent(`after-${created}`, `s-after-${created}`), options: {}, cancel() {}, whenIdle: () => Promise.resolve() },
        dispose: () => Promise.resolve(),
      })
    },
  })
  const channel = createChannel(ctx as never, makeAgent('before', 's-before') as never, {
    model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
  })
  const instance = await render(React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen: false, trajectorySeen: true,
    kernelEntries: kernelEntriesOf(listBackends()),
  }))
  /** Local rows titled after one report: one per push onto the bound session. */
  const reports = (title: string): number => channel.rows.filter(row => row.text === title).length

  /** Positive control first (the same rig does push the report when nothing is
   *  held), then a `/new` between the ask and the answer. */
  const fenced = async (
    fenceTag: string,
    command: string,
    title: string,
    gate: Gate<unknown>,
  ): Promise<void> => {
    await run(command)
    check(`${fenceTag}: the report lands on the session that asked for it`,
      await settled(() => reports(title) === 1), `${reports(title)} · ${screen()}`)

    // Type first, hold after: a completion warm this keystroke run may trigger
    // is answered normally, so what gets parked is the report's own call.
    await type(command)
    gate.setHold(true)
    stdin.write('\r')
    await settle(() => gate.waiting >= 1)
    check(`${fenceTag}: the report is in flight`, gate.waiting >= 1, String(gate.waiting))

    const generation = channel.agentBindingGeneration
    check(`${fenceTag}: /new rebinds the channel`,
      (await channel.newSession()) === true && channel.agentBindingGeneration !== generation,
      `${generation} -> ${channel.agentBindingGeneration}`)
    check(`${fenceTag}: the new session starts without the old report`, reports(title) === 0, String(reports(title)))

    gate.releaseAll()
    // The whole late-answer chain is microtasks — no timers — so one macrotask
    // boundary is enough to know the guard has run (no fixed window).
    await tick()
    check(`${fenceTag}: nothing was left unanswered`, gate.waiting === 0, String(gate.waiting))
    check(`${fenceTag}: an answer that lands after the switch stays out of the new session`,
      reports(title) === 0, channel.rows.map(row => row.text).join(' | '))
  }

  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    await fenced(`${tag} /plugin`, '/plugin list', '/plugin', bundleGate)
    await fenced(`${tag} /agents`, '/agents', '/agents', childGate)
  } finally {
    instance.unmount()
    channel.releaseContributions()
    term.dispose()
  }
}
console.log(`verify-plugin-manager-chat OK (${passed} checks)`)
