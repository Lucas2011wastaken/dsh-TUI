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
import type { PluginInstallFlow } from '../src/dsh-adapter/plugin-install.js'
import type { PluginInstallNotice } from '../src/dsh-adapter/plugin-declaration.js'
import type { FirstPartyEntry, FirstPartyFeedLoad } from '../src/dsh-adapter/plugin-feed.js'
import type { PluginInstallSink } from '../src/dsh-adapter/plugin-install.js'
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallCancellation,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginSpecInspection,
} from '@deepseek-ai/dsh-plugin-manager/types'

const [{ Writable, PassThrough }, { mkdtempSync, mkdirSync, readFileSync, writeFileSync }, { tmpdir }, { join }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { pluginReport, parsePluginArgs }, { kernelEntriesOf }, { listBackends }, { findText, settle, settled, sleep, viewportLines }, { Context }, { createPluginInstallFlow, createPluginInstallEntry }, { COMPOSITION_PACKAGE }, { pathToFileURL }, { createDshSession }, { PluginInstallPane }] = await Promise.all([
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
  import('../src/dsh-adapter/plugin-install.js'),
  import('../src/dsh-adapter/plugin-declaration.js'),
  import('node:url'),
  import('../src/dsh-adapter/backend/session.js'),
  import('../src/components/PluginInstallPane.js'),
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
  // The write half (C-4). The read-only forms never reach these; the install
  // flow below hands in its own service so every write stays assertable.
  installBundle: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: 'verify-fresh-plugin' }),
  cancelInstall: () => Promise.resolve({ status: 'cancelled' }),
  listVersionExemptions: () => ({ exemptions: {}, warnings: [] }),
  setVersionExemption: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'enable', target: 'verify-fresh-plugin' }),
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
          hasText(t('sugg-plugin-list-desc')) && hasText(t('sugg-plugin-registries-desc')) &&
          hasText(t('sugg-plugin-install-desc')), screen())
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
      // The write path degrades to the same place (C-4): an install form this
      // composition cannot run through the service answers with the CLI route
      // instead of pretending to install.
      await clear()
      await run('/plugin install verify-fresh-plugin')
      check(`${tag}: an install form without the service points at the CLI`,
        await settled(() => hasText('dsh plugin --profile dsh-tui') && hasText('ctx.pluginManager')), screen())
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
    // …including the write path: a form the list forgets is a form nobody
    // discovers (the list is prose, so nothing else can catch it).
    check(`${tag}: the unknown-subcommand list names the install form`,
      await settled(() => hasText('install <spec>')), screen())
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
// ── The install flow, headless (C-4) ─────────────────────────────────────────
// What `/plugin install` asks about, what it refuses to guess, and what it does
// with each shape of result. No terminal: the flow's whole contract is the
// steps it hands back and the lines it writes, and a fake service can produce
// every branch (a real one needs pnpm, a profile and a network).
{
  const tag = 'install flow'
  const PLUGIN = '@probe/verify-fresh-plugin'
  const VERSION = '9.9.9'
  const feedOf = (...entries: FirstPartyEntry[]): FirstPartyFeedLoad =>
    ({ kind: 'ok', path: '/probe/tui-profile/feed/first-party.json', feed: { feedVersion: 1, entries } })
  const TRUSTED = feedOf({ name: PLUGIN, scope: '@probe', version: VERSION })
  /** The same feed, one version behind: "we publish this, but not this artifact". */
  const STALE = feedOf({ name: PLUGIN, scope: '@probe', version: '0.0.1' })
  /** A feed nobody could read (missing file, corrupt bytes): vouches for nothing. */
  const NO_FEED: FirstPartyFeedLoad = { kind: 'unavailable', reason: 'feed file is missing (probe)' }
  const ACCEPTED = { status: 'accepted', kind: 'registry', name: PLUGIN, version: VERSION, bundle: true, registry: null } as const
  const CHANGE = { changed: true, application: 'restart-required', stage: 'install', target: PLUGIN } as const

  interface Rig {
    readonly flow: PluginInstallFlow
    readonly lines: string[]
    readonly installs: InstallBundleOptions[]
    /** The spec each `installBundle` call was handed, in order. */
    readonly installSpecs: string[]
    /** How many times the inspection ran: a refused install makes none. */
    readonly inspections: number
    readonly cancels: PluginInstallRequestId[]
    /** `[package@version, runtime version, enabled, accept risk]` per exemption granted. */
    readonly exemptions: string[][]
    setInstall(next: () => Promise<ChangeResult>): void
    emitState(progress: PluginInstallProgress): void
    emitLog(chunk: PluginInstallLogChunk): void
  }

  function makeInstallRig(options: {
    readonly feed: FirstPartyFeedLoad
    readonly inspect?: PluginSpecInspection | (() => Promise<PluginSpecInspection>)
    readonly notice?: (target: { readonly name?: string; readonly directory?: string }) => PluginInstallNotice
    readonly binding?: () => number
    /** What the person typed; the pinned form of this feed's entry by default. */
    readonly spec?: string
    /** Whether a turn is running; idle unless a case says otherwise. */
    readonly busy?: () => boolean
    readonly ownVersion?: string
    readonly bundles?: BundleInfo[]
    readonly install?: () => Promise<ChangeResult>
    /** Defers the service's answer to `cancelInstall`: the rollback's own clock. */
    readonly cancel?: () => Promise<PluginInstallCancellation>
    /** Overrides the exemptions reader (including one that throws synchronously). */
    readonly readExemptions?: () => { exemptions: Record<string, string[]>; warnings: string[] }
    readonly exempt?: (packageVersion: string, runtimeVersion: string) => Promise<ChangeResult>
  }): Rig {
    const lines: string[] = []
    const installs: InstallBundleOptions[] = []
    const installSpecs: string[] = []
    let inspections = 0
    const cancels: PluginInstallRequestId[] = []
    const exemptions: string[][] = []
    let install = options.install ?? (() => Promise.resolve(CHANGE))
    const state: Array<(progress: PluginInstallProgress) => void> = []
    const log: Array<(chunk: PluginInstallLogChunk) => void> = []
    const service: PluginManagerView = {
      ...manager,
      inspect: () => {
        inspections += 1
        return typeof options.inspect === 'function' ? options.inspect() : Promise.resolve(options.inspect ?? ACCEPTED)
      },
      installBundle: (spec, settings) => { installSpecs.push(spec); installs.push(settings ?? {}); return install() },
      cancelInstall: requestId => {
        cancels.push(requestId)
        return options.cancel?.() ?? Promise.resolve({ status: 'cancelled' } as const)
      },
      listVersionExemptions: options.readExemptions ?? (() => ({ exemptions: {}, warnings: [] })),
      setVersionExemption: (packageVersion, runtimeVersion, enabled, acceptRisk) => {
        exemptions.push([packageVersion, runtimeVersion, String(enabled), String(acceptRisk)])
        return options.exempt?.(packageVersion, runtimeVersion) ?? Promise.resolve(CHANGE)
      },
      listBundles: () => Promise.resolve(options.bundles ?? []),
    }
    const flow = createPluginInstallFlow({
      manager: service,
      // A precise `name@version` by default: only a spec that names the version
      // can be the artifact the feed pinned (see the bare-name case below).
      spec: options.spec ?? `${PLUGIN}@${VERSION}`,
      feed: options.feed,
      noticeOf: options.notice ?? (() => ({ kind: 'declared' })),
      binding: options.binding ?? (() => 0),
      busy: options.busy ?? (() => false),
      onLines: batch => { lines.push(...batch) },
      events: {
        onState: (_requestId, listener) => { state.push(listener); return () => undefined },
        onLog: (_requestId, listener) => { log.push(listener); return () => undefined },
      },
      ownVersion: options.ownVersion,
      requestId: 'probe-request' as PluginInstallRequestId,
    })
    return {
      flow, lines, installs, installSpecs, cancels, exemptions,
      get inspections(): number { return inspections },
      setInstall: next => { install = next },
      emitState: progress => { for (const listener of state) listener(progress) },
      emitLog: chunk => { for (const listener of log) listener(chunk) },
    }
  }

  // The trust route: a feed hit with a readable declaration is the one case that
  // installs without asking, and it still leaves an audit line.
  {
    const rig = makeInstallRig({ feed: TRUSTED })
    const step = await rig.flow.begin()
    check(`${tag}: a first-party package with a declaration installs without asking`,
      step.kind === 'done' && rig.installs.length === 1, `${step.kind} · ${rig.installs.length}`)
    check(`${tag}: skipping the confirmation still leaves an audit line`,
      rig.lines.some(line => line.includes('First-party (feed hit)') && line.includes(`${PLUGIN}@${VERSION}`)),
      rig.lines.join(' | '))
    check(`${tag}: the install carries the request id the flow owns`,
      rig.installs[0]?.requestId === rig.flow.requestId, JSON.stringify(rig.installs[0]))
    check(`${tag}: the service is asked for the exact version that was inspected`,
      rig.installSpecs[0] === `${PLUGIN}@${VERSION}`, JSON.stringify(rig.installSpecs))
  }

  // What the person confirmed is what the service is asked to install. A bare
  // name, a range or a tag is resolved again by the install (and again by a
  // retry), so it is not the pinned artifact — and the install is pinned to the
  // version the inspection read, whatever the spec spelled.
  for (const [label, spec] of [
    ['a bare name', PLUGIN],
    ['a range', `${PLUGIN}@^1`],
    ['a tag', `${PLUGIN}@latest`],
  ] as const) {
    const rig = makeInstallRig({ feed: TRUSTED, spec, notice: () => ({ kind: 'declared' }) })
    const step = await rig.flow.begin()
    check(`${tag}: ${label} is not treated as the artifact the feed pinned`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'version-mismatch',
      JSON.stringify(step))
    const after = await rig.flow.confirm()
    check(`${tag}: ${label} installs the exact version the inspection read`,
      after.kind === 'done' && JSON.stringify(rig.installSpecs) === JSON.stringify([`${PLUGIN}@${VERSION}`]),
      JSON.stringify(rig.installSpecs))
  }

  // A turn is running: the install refuses before it asks anything. The check is
  // repeated before the write, because a turn can start while the pane waits.
  {
    const rig = makeInstallRig({ feed: TRUSTED, busy: () => true })
    const step = await rig.flow.begin()
    check(`${tag}: a running turn refuses the install before any service call`,
      step.kind === 'done' && rig.inspections === 0 && rig.installSpecs.length === 0,
      `${step.kind} · inspections ${rig.inspections} · installs ${rig.installSpecs.length}`)
    check(`${tag}: the refusal says what to do about it`,
      rig.lines.includes(t('plugins-install-busy')), rig.lines.join(' | '))
  }
  {
    let busy = false
    const rig = makeInstallRig({ feed: TRUSTED, spec: PLUGIN, busy: () => busy })
    const step = await rig.flow.begin()
    check(`${tag}: an idle turn still asks first`, step.kind === 'confirm', JSON.stringify(step))
    busy = true
    const after = await rig.flow.confirm()
    check(`${tag}: a turn that started while the pane was open stops the write`,
      after.kind === 'done' && rig.installSpecs.length === 0 && rig.lines.includes(t('plugins-install-busy')),
      `${after.kind} · ${rig.installSpecs.length} · ${rig.lines.join(' | ')}`)
  }

  // Fail closed: an unlisted name, a listed name at another version, and a feed
  // nobody could read all ask first — and none of them installs before the answer.
  for (const [label, feed, reason] of [
    ['a name the feed does not list', feedOf(), 'not-listed'],
    ['a listed name at another version', STALE, 'version-mismatch'],
    ['a feed that cannot be read', NO_FEED, 'no-feed'],
  ] as const) {
    const rig = makeInstallRig({ feed, notice: () => ({ kind: 'unjudged' }) })
    const step = await rig.flow.begin()
    check(`${tag}: ${label} is asked about before anything installs`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === reason && rig.installs.length === 0,
      `${step.kind} · ${step.kind === 'confirm' ? step.trust.kind : ''} · installs ${rig.installs.length}`)
    check(`${tag}: ${label} keeps the notice the wiring read (gate 1)`,
      step.kind === 'confirm' && step.notice.kind === 'unjudged', JSON.stringify(step))
    const after = await rig.flow.confirm()
    check(`${tag}: ${label} installs once the person confirms`,
      after.kind === 'done' && rig.installs.length === 1, `${after.kind} · ${rig.installs.length}`)
  }

  // A first-party package whose declaration is missing still asks: gate 1 has
  // something to say even when the feed vouches for the artifact.
  {
    const rig = makeInstallRig({ feed: TRUSTED, notice: () => ({ kind: 'undeclared' }) })
    const step = await rig.flow.begin()
    check(`${tag}: a first-party package with no declaration still gets gate 1's notice`,
      step.kind === 'confirm' && step.trust.kind === 'first-party' && step.notice.kind === 'undeclared' && rig.installs.length === 0,
      JSON.stringify(step))
  }

  // A spec the service refuses never reaches an install.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: { status: 'refused', problem: 'not-found', reason: '404 Not Found' },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a refused spec reports itself and installs nothing`,
      step.kind === 'done' && rig.installs.length === 0 &&
      rig.lines.some(line => line.includes('Not installable: not-found — 404 Not Found')), rig.lines.join(' | '))
  }

  // Build scripts: the service blocks the install, the approval retries with them.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({ ...CHANGE, application: 'failed', pendingBuilds: ['esbuild', 'sharp'] }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: blocked build scripts come back as a decision`,
      step.kind === 'build-blocked' && step.builds.join(',') === 'esbuild,sharp', JSON.stringify(step))
    rig.setInstall(() => Promise.resolve(CHANGE))
    const after = await rig.flow.approve(['esbuild', 'sharp'])
    check(`${tag}: approving the scripts writes them into the retry`,
      after.kind === 'done' && rig.installs.length === 2 &&
      JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild","sharp"]',
      JSON.stringify(rig.installs))
    check(`${tag}: the approval is reported before the retry`,
      rig.lines.some(line => line.includes('Approved 2 build scripts')), rig.lines.join(' | '))
  }

  // An incompatible version: the service's own list, and the exemption escape.
  {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: { '@deepseek-ai/dsh': '^9' } }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: an incompatible version comes back with the packages and the exemptions`,
      step.kind === 'incompatible' && step.packages.length === 1 && step.exemptions.exemptions !== undefined,
      JSON.stringify(step))
    rig.setInstall(() => Promise.resolve(CHANGE))
    const after = await rig.flow.acceptRisk()
    check(`${tag}: accepting the risk registers the exact exemption and retries`,
      after.kind === 'done' && rig.exemptions.length === 1 &&
      rig.exemptions[0]?.join('|') === 'verify-other@1.0.0|0.2.0-rc.2|true|true' && rig.installs.length === 2,
      `${JSON.stringify(rig.exemptions)} · installs ${rig.installs.length}`)
  }

  // A pending input can start a turn while the incompatible pane waits. The
  // exemption itself writes and reloads the profile, before the install retry.
  for (const becomesBusy of ['before approval', 'during the first write'] as const) {
    let busy = false
    const peers = ['probe-peer-a', 'probe-peer-b'].map(name => ({
      name, version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {},
    }))
    const rig = makeInstallRig({
      feed: TRUSTED,
      busy: () => busy,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: peers },
      }),
      exempt: () => {
        busy = true
        return Promise.resolve(CHANGE)
      },
    })
    const blocked = await rig.flow.begin()
    check(`${tag}: ${becomesBusy} starts from the incompatible decision`, blocked.kind === 'incompatible')
    if (becomesBusy === 'before approval') busy = true
    const after = await rig.flow.acceptRisk()
    check(`${tag}: ${becomesBusy} stops all subsequent profile writes`,
      after.kind === 'done' && rig.exemptions.length === (becomesBusy === 'before approval' ? 0 : 1)
      && rig.installs.length === 1 && rig.lines.includes(t('plugins-install-busy')),
      `${JSON.stringify(rig.exemptions)} · installs ${rig.installs.length}`)
    rig.flow.dispose()
  }

  // The service answers a refusal in-band (a stale runtime version, a
  // compatibility file it will not rewrite): reporting that as "recorded" and
  // retrying would loop forever.
  {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
      exempt: () => Promise.resolve({
        ...CHANGE, application: 'failed', stage: 'enable', error: { code: 'stale-approval', diagnostic: 'cannot approve a runtime this app is not running' },
      }),
    })
    const blocked = await rig.flow.begin()
    const step = await rig.flow.acceptRisk()
    check(`${tag}: a refused exemption is reported, not retried as if it had been granted`,
      blocked.kind === 'incompatible' && step.kind === 'done' && rig.installs.length === 1 &&
      rig.lines.some(line => line.includes('stale-approval')) &&
      !rig.lines.some(line => line.includes('Recorded an exact-version exemption')),
      `${blocked.kind} · ${rig.lines.join(' | ')}`)
  }

  // The exemptions reader is the one service call that answers synchronously:
  // it can throw past a promise's catch, and the flow contains it either way.
  {
    const peer = { name: 'verify-other', version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: [peer] },
      }),
      readExemptions: () => { throw new Error(SYNC_FAILURE) },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a service that throws while reading the exemptions is contained in one line`,
      step.kind === 'incompatible' && step.exemptions.exemptions !== undefined &&
      rig.lines.some(line => line.includes(SYNC_FAILURE)), rig.lines.join(' | '))
  }

  // A directory spec whose own manifest claims a feed entry: the feed lists what
  // was published, and a directory vouching for itself is not that.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: { status: 'accepted', kind: 'path', name: PLUGIN, version: VERSION, bundle: true, registry: null },
      notice: () => ({ kind: 'declared' }),
    })
    const step = await rig.flow.begin()
    check(`${tag}: a path spec cannot claim a feed entry to skip the confirmation`,
      step.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'unverifiable-source' &&
      rig.installs.length === 0, JSON.stringify(step))
  }

  // A failure keeps the evidence, loses the credentials, and says how to retry.
  {
    const output = 'first line\nlast line\nfrom https://reader:probe-secret@registry.example.com/x'
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        // The real service emits the stream and repeats its capture in the
        // result; evidence must come from the former, before byte truncation.
        rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
          stream: 'stderr', text: output,
        })
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: output },
          packageResult: { exitCode: 1, truncated: false, logPath: '/probe/pnpm.log', output },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a failed install reports the reason, the tail and the manual command`,
      step.kind === 'done' && rig.lines.some(line => line.includes('operation-error')) &&
      rig.lines.some(line => line.includes('last line')) &&
      // The manual command names the spec that was actually attempted (the pinned
      // version), so running it reproduces the install that failed.
      rig.lines.some(line => line.includes(`dsh plugin --profile dsh-tui add ${PLUGIN}@${VERSION}`)) &&
      rig.lines.some(line => line.includes('dsh-tui safe --rescue')), rig.lines.join(' | '))
    check(`${tag}: the tail never carries the credentials of the registry it quotes`,
      !rig.lines.some(line => line.includes('probe-secret')), rig.lines.join(' | '))
  }

  // The service retains the last outputBytes bytes, and reuses that capture
  // as the error diagnostic. Its leading fragment can be inside credentials.
  for (const [label, prefix, suffix] of [
    ['userinfo', 'fetch https://reader:', '@registry.example.com/x'],
    ['query token', 'GET https://registry.example.com/x?token=', ''],
  ] as const) {
    const secret = 'probe-cutoff-secret'
    const full = `${prefix}${'p'.repeat(1000)}${secret}${suffix} ${'x'.repeat(16200)}\ncomplete captured line\n`
    const bytes = Buffer.from(full)
    const output = bytes.subarray(bytes.length - 16384).toString('utf8')
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        rig.emitLog({ requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text: full })
        return Promise.resolve({
          ...CHANGE, application: 'failed',
          error: { code: 'operation-error', diagnostic: output },
          packageResult: { exitCode: 1, output, truncated: true },
        })
      },
    })
    await rig.flow.begin()
    check(`${tag}: a capture starting inside ${label} leaks neither its diagnostic nor its tail`,
      !rig.lines.some(line => line.includes(secret)), rig.lines.join(' | '))
    check(`${tag}: truncation preserves complete captured lines and the structured reason (${label})`,
      rig.lines.some(line => line.includes('complete captured line')) && rig.lines.some(line => line.includes('operation-error')),
      rig.lines.join(' | '))
  }

  // Upstream captures the last 16 KiB, byte by byte, and copies that capture
  // into its failure diagnostic. A retained suffix can lose its URL header.
  // Mixing stdout/stderr can split a URL even without truncating any bytes.
  for (const source of ['userinfo tail', 'query tail', 'interleaved streams'] as const) {
    const secret = 'probe-captured-secret-1528'
    const suffix = source === 'query tail' ? `${secret}&padding=` : `${secret}@registry.example.com/x `
    const prefix = source === 'query tail' ? 'GET https://registry.example.com/x?token=' : 'fetch https://reader:'
    const whole = `${prefix}${suffix}${'x'.repeat(16384 - Buffer.byteLength(suffix))}`
    const captured = source === 'interleaved streams'
      ? `${prefix}stderr-evidence\n${secret}@registry.example.com/x\n`
      : Buffer.from(whole).subarray(-16384).toString('utf8')
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const log = (text: string, stream: 'stdout' | 'stderr') => rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream, text,
        })
        if (source === 'interleaved streams') {
          log(prefix, 'stdout')
          log('stderr-evidence\n', 'stderr')
          log(`${secret}@registry.example.com/x\n`, 'stdout')
        } else {
          log(`${whole}\n`, 'stdout')
        }
        log('retained-event-evidence\n', 'stderr')
        return Promise.resolve({
          ...CHANGE, application: 'failed',
          error: { code: 'operation-error', diagnostic: captured },
          packageResult: {
            exitCode: 1, truncated: source !== 'interleaved streams', logPath: '/probe/pnpm.log', output: captured,
          },
        })
      },
    })
    const after = await rig.flow.begin()
    check(`${tag}: ${source} cannot reintroduce credentials through output or diagnostic`,
      after.kind === 'done' && !rig.lines.some(line => line.includes(secret)), rig.lines.join(' | '))
    check(`${tag}: ${source} still reports the failure and complete event evidence`,
      rig.lines.some(line => line.includes('operation-error')) && rig.lines.includes('  retained-event-evidence'),
      rig.lines.join(' | '))
    rig.flow.dispose()
  }

  // Logs use a byte budget, including incomplete lines. Never truncate a
  // credential-bearing line into a printable suffix; discard through its next
  // newline, then resume normally. A CR-only progress stream is still one line.
  for (const source of ['one chunk', 'many CR-only chunks', 'wide characters'] as const) {
    const rejectedPrefix = 'OVER-BUDGET-1528'
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const log = (text: string) => rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text,
        })
        // Exactly 16 KiB remains admissible, independently of the implementation's constant.
        const acceptedPrefix = 'AT-BYTE-LIMIT-1528'
        log(`${acceptedPrefix}${'x'.repeat(16384 - acceptedPrefix.length)}\n`)
        log(`${rejectedPrefix} https://reader:probe-oversize-secret@registry.example.com/x `)
        if (source === 'wide characters') log('界'.repeat(5500))
        else if (source === 'one chunk') log('x'.repeat(32768))
        else for (let index = 0; index < 128; index += 1) log(`${'x'.repeat(2048)}\r`)
        log('\nRECOVERED-EVIDENCE-1528\n')
        return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'operation-error' } })
      },
    })
    await rig.flow.begin()
    const tail = rig.lines.filter(line => line.startsWith('  '))
    check(`${tag}: ${source} drops the whole oversized line, including its prefix`,
      !rig.lines.some(line => line.includes(rejectedPrefix) || line.includes('probe-oversize-secret')),
      rig.lines.join(' | '))
    check(`${tag}: ${source} keeps the byte-limit line and resumes after the discarded one`,
      tail.some(line => line.includes('AT-BYTE-LIMIT-1528')) && tail.includes('  RECOVERED-EVIDENCE-1528')
      && tail.length === 3,
      tail.join(' | '))
    rig.flow.dispose()
  }

  // Failures applying a bundle after pnpm succeeded still have whole activation
  // diagnostics, rather than the failed package run's opaque capture.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({
        ...CHANGE, application: 'failed',
        error: { code: 'operation-error', diagnostic: 'activation-evidence-1528' },
        packageResult: { exitCode: 0, truncated: false, output: '', logPath: '/probe/pnpm.log' },
      }),
    })
    await rig.flow.begin()
    check(`${tag}: a failed activation retains its own diagnostic`,
      rig.lines.some(line => line.includes('activation-evidence-1528')), rig.lines.join(' | '))
    rig.flow.dispose()
  }

  // pnpm writes a stream chunk by chunk, and a credential can straddle two of
  // them. Redaction reads URLs, so a fragment that lost its `scheme://user:`
  // head is not one — the line has to be whole before it is judged. Both split
  // positions are covered: inside the userinfo, and inside a query token.
  for (const [label, chunks] of [
    ['userinfo', ['fetch https://reader:', 'probe-secret@registry.example.com/x\n']],
    ['a query token', ['GET https://registry.example.com/x?token=', 'probe-secret\n']],
  ] as const) {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        for (const text of chunks) {
          rig.emitLog({
            requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
            stream: 'stdout', text,
          })
        }
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a credential split across log chunks (${label}) stays out of the report`,
      step.kind === 'done' && !rig.lines.some(line => line.includes('probe-secret')),
      rig.lines.join(' | '))
    check(`${tag}: the same URL is still reported, redacted, once its chunks are joined (${label})`,
      rig.lines.some(line => line.includes('https://registry.example.com/x')), rig.lines.join(' | '))
  }

  // The other end of the same rule: a stream that ends without a newline has
  // still said its last line, and the report keeps it.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        rig.emitLog({
          requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe',
          stream: 'stderr', text: 'last line without a newline',
        })
        return Promise.resolve({
          ...CHANGE,
          application: 'failed',
          error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
        })
      },
    })
    const step = await rig.flow.begin()
    check(`${tag}: a final line with no newline is still reported`,
      step.kind === 'done' && rig.lines.some(line => line.includes('last line without a newline')),
      rig.lines.join(' | '))
  }

  // An oversized line cannot be cut into a publishable suffix. Drop it through
  // its delimiter, keep other streams independent, and resume on the next line.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => {
        const identity = { requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe' }
        rig.emitLog({ ...identity, stream: 'stdout', text: `oversized-line https://reader:${'x'.repeat(65536)}` })
        rig.emitLog({ ...identity, stream: 'stderr', text: 'independent stream line\n' })
        rig.emitLog({ ...identity, stream: 'stdout', text: 'probe-secret@registry.example.com/x\nnext complete line\n' })
        rig.emitLog({ ...identity, stream: 'stdout', text: `oversized-final-line ${'x'.repeat(65536)}` })
        return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'operation-error' } })
      },
    })
    await rig.flow.begin()
    check(`${tag}: oversized lines and their credential suffixes are discarded, including at EOF`,
      !rig.lines.some(line => /oversized-|probe-secret/u.test(line)), rig.lines.join(' | '))
    check(`${tag}: a discarded line does not lose the next line or another stream`,
      rig.lines.some(line => line.includes('next complete line')) && rig.lines.some(line => line.includes('independent stream line')),
      rig.lines.join(' | '))
  }

  // A service that throws before it hands back a promise: contained like a rejection.
  {
    const rig = makeInstallRig({ feed: TRUSTED, install: () => { throw new Error(SYNC_FAILURE) } })
    const step = await rig.flow.begin()
    check(`${tag}: a service that throws synchronously is contained in one line`,
      step.kind === 'done' && rig.lines.some(line => line.includes(SYNC_FAILURE)), rig.lines.join(' | '))
  }

  // Cancellation: the service's own three-state answer, and no second ending.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => {
        // The service's cancelled answer follows the owned install's rollback.
        resolveInstall?.({ ...CHANGE, application: 'cancelled' })
        return Promise.resolve({ status: 'cancelled' })
      },
    })
    const pending = rig.flow.begin()
    await tick()
    const step = await rig.flow.cancel()
    check(`${tag}: cancelling asks the service for that very request`,
      step.kind === 'done' && rig.cancels.length === 1 && rig.cancels[0] === rig.flow.requestId,
      JSON.stringify(rig.cancels))
    check(`${tag}: the cancellation is reported exactly once`,
      rig.lines.filter(line => line.includes(t('plugins-install-cancelled'))).length === 1, rig.lines.join(' | '))
    // A second Esc (or a second call from anywhere) must not ask again: the first
    // answer is the one that gets reported.
    await rig.flow.cancel()
    check(`${tag}: a second cancel does not ask the service again`,
      rig.cancels.length === 1 && rig.lines.filter(line => line.includes('Install cancelled')).length === 1,
      `${rig.cancels.length} · ${rig.lines.join(' | ')}`)
    await pending
    check(`${tag}: an install that ends cancelled does not report a second ending`,
      !rig.lines.some(line => line.includes('Install failed')), rig.lines.join(' | '))
  }

  // Cancellation refusal or failure does not settle an applying installation.
  for (const status of ['too-late', 'not-running', 'rejected'] as const) {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => status === 'rejected'
        ? Promise.reject(new Error('cancel fixture failed'))
        : Promise.resolve({ status }),
    })
    const pending = rig.flow.begin()
    await tick()
    const first = rig.flow.cancel()
    const second = rig.flow.cancel()
    let cancelled = false
    void first.then(() => { cancelled = true })
    await tick()
    check(`${tag}: ${status} cancellation keeps waiting for the owned install`,
      !cancelled && rig.cancels.length === 1, `${cancelled} · ${rig.cancels.length}`)
    resolveInstall?.(CHANGE)
    await pending
    check(`${tag}: ${status} cancellation settles once the install finishes, including repeated calls`,
      (await first).kind === 'done' && (await second).kind === 'done' &&
      rig.lines.some(line => line.includes(`Installed ${PLUGIN}`)), rig.lines.join(' | '))
  }

  // Cancelling while one exemption is being written waits for that write and
  // starts no more. The completed exemption is reported, never called undone.
  {
    let resolveExemption: ((result: ChangeResult) => void) | undefined
    const packages = ['verify-one', 'verify-two'].map(name => ({ name, version: '1.0.0', runtimeVersion: '0.2.0-rc.2', peers: {} }))
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'incompatible-version', incompatible: packages } }),
      exempt: () => new Promise<ChangeResult>(resolve => { resolveExemption = resolve }),
    })
    const blocked = await rig.flow.begin()
    const granting = rig.flow.acceptRisk()
    const cancellation = rig.flow.cancel()
    let cancelled = false
    void cancellation.then(() => { cancelled = true })
    await tick()
    check(`${tag}: cancelling an exemption waits for the write and does not cancel an expired install`,
      blocked.kind === 'incompatible' && !cancelled && rig.exemptions.length === 1 && rig.cancels.length === 0,
      `${cancelled} · ${JSON.stringify(rig.exemptions)} · ${JSON.stringify(rig.cancels)}`)
    resolveExemption?.(CHANGE)
    await granting
    check(`${tag}: cancellation prevents subsequent exemptions and the install retry`,
      (await cancellation).kind === 'done' && rig.exemptions.length === 1 && rig.installs.length === 1,
      `${JSON.stringify(rig.exemptions)} · ${rig.installs.length}`)
    check(`${tag}: cancellation reports the one exemption that did land`,
      rig.lines.includes(t('plugins-install-exempted', { count: '1' })) && !rig.lines.includes(t('plugins-install-exempted', { count: '2' })),
      rig.lines.join(' | '))
  }

  // Two Escs, one rollback. A repeated cancel shares the owned wait, so a
  // second cancel answers only when the first one does: a `done` that lands
  // before the profile is restored is what lets the screen close the pane (and
  // hand the prompt back) over work that is still going on.
  {
    let resolveCancel: ((value: PluginInstallCancellation) => void) | undefined
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => new Promise<PluginInstallCancellation>(resolve => { resolveCancel = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    const first = rig.flow.cancel()
    const second = rig.flow.cancel()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await tick()
    check(`${tag}: a repeated cancel waits for the rollback instead of answering early`,
      !secondSettled && rig.cancels.length === 1, `settled ${secondSettled} · ${rig.cancels.length}`)
    resolveCancel?.({ status: 'cancelled' })
    resolveInstall?.({ ...CHANGE, application: 'cancelled' })
    await pending
    check(`${tag}: both cancels settle on the one answer`,
      (await first).kind === 'done' && (await second).kind === 'done', `${secondSettled}`)
    check(`${tag}: the rollback is still announced exactly once`,
      rig.lines.filter(line => line.includes(t('plugins-install-cancelled'))).length === 1,
      rig.lines.join(' | '))
  }

  // Closing the pane while the spec is still being read: the inspection's answer
  // must not start an install, and there is nothing in flight to cancel.
  {
    let resolveInspect: ((value: PluginSpecInspection) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      inspect: () => new Promise<PluginSpecInspection>(resolve => { resolveInspect = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    const step = await rig.flow.cancel()
    resolveInspect?.(ACCEPTED)
    check(`${tag}: cancelling while the spec is still being read installs nothing`,
      (await pending).kind === 'done' && step.kind === 'done' && rig.installs.length === 0,
      `${rig.installs.length} installs · ${rig.lines.join(' | ')}`)
    check(`${tag}: cancelling before anything started does not ask the service to cancel`,
      rig.cancels.length === 0, JSON.stringify(rig.cancels))
    check(`${tag}: nothing claims an install was cancelled when none had started`,
      !rig.lines.some(line => line.includes('Install cancelled') || line.includes('realign it')),
      rig.lines.join(' | '))
  }

  // The fence: a session that moved on gets no further lines, and the run goes on.
  {
    let binding = 7
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      binding: () => binding,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    binding = 8
    rig.emitState({ requestId: rig.flow.requestId, phase: 'installing', attempt: { registry: 'https://registry.example.com/', index: 1, total: 2 } })
    rig.emitLog({ requestId: rig.flow.requestId, jobId: 'job', argv: ['pnpm'], cwd: '/probe', stream: 'stdout', text: 'late output' })
    resolveInstall?.({ ...CHANGE })
    await pending
    check(`${tag}: a report for a session that moved on stays out of the transcript`,
      !rig.lines.some(line => line.includes('Asking registry') || line.includes('late output') || line.includes('Installed')),
      rig.lines.join(' | '))
    check(`${tag}: the lines written while it was still bound are kept`,
      rig.lines.some(line => line.includes('First-party (feed hit)')), rig.lines.join(' | '))
  }

  // Progress: the service's own phases, in the transcript, before the result.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = makeInstallRig({
      feed: TRUSTED,
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
    })
    const pending = rig.flow.begin()
    await tick()
    rig.emitState({ requestId: rig.flow.requestId, phase: 'installing', attempt: { registry: 'https://registry.example.com/', index: 1, total: 2 } })
    rig.emitState({ requestId: rig.flow.requestId, phase: 'applying' })
    resolveInstall?.({ ...CHANGE })
    await pending
    check(`${tag}: the registry attempts and the applying phase are reported`,
      rig.lines.some(line => line.includes('Asking registry 1/2') && line.includes('registry.example.com')) &&
      rig.lines.some(line => line.includes('Applying')), rig.lines.join(' | '))
    check(`${tag}: the result follows the progress it reports`,
      rig.lines.findIndex(line => line.includes('Installed')) >
      rig.lines.findIndex(line => line.includes('Asking registry')), rig.lines.join(' | '))
    check(`${tag}: a restart-required install says so, and asks for the restart`,
      rig.lines.some(line => line.includes('restart required')) &&
      rig.lines.some(line => line.includes('Restart this app')), rig.lines.join(' | '))
  }

  // #1340: an install that moves this application's own version is reported,
  // never repaired.
  {
    const rig = makeInstallRig({
      feed: TRUSTED,
      ownVersion: '0.15.0',
      bundles: [{
        name: COMPOSITION_PACKAGE, version: '0.14.0', enabled: true, installed: true,
        optional: false, removable: true, rows: [], overrides: [],
      }],
    })
    await rig.flow.begin()
    check(`${tag}: an install that moved this app's own version is reported with the fix`,
      rig.lines.some(line => line.includes('0.14.0') && line.includes('0.15.0') &&
        line.includes(`dsh plugin --profile dsh-tui add ${COMPOSITION_PACKAGE}@0.15.0`)), rig.lines.join(' | '))
  }
  {
    const rig = makeInstallRig({ feed: TRUSTED, ownVersion: '0.15.0' })
    await rig.flow.begin()
    check(`${tag}: an install that left this app's own version alone is silent about it`,
      !rig.lines.some(line => line.includes('realign it')), rig.lines.join(' | '))
  }
}

// ── `/plugin install` through the real Chat (C-4) ───────────────────────────
// The pane the flow asks through: gate 1's notice, gate 3's routing, and the one
// step where a person approves build scripts. The flow is the real one; only the
// service, the feed and the clock's answers are fixtures.
{
  const tag = 'install pane'
  const PLUGIN = '@probe/verify-fresh-plugin'
  const VERSION = '9.9.9'
  const accepted = { status: 'accepted', kind: 'registry', name: PLUGIN, version: VERSION, bundle: true, registry: null } as const
  const firstParty: FirstPartyFeedLoad = {
    kind: 'ok', path: '/probe/tui-profile/feed/first-party.json',
    feed: { feedVersion: 1, entries: [{ name: PLUGIN, scope: '@probe', version: VERSION }] },
  }
  const noFeed: FirstPartyFeedLoad = { kind: 'unavailable', reason: 'feed file is missing (probe)' }
  const CHANGE = { changed: true, application: 'restart-required', stage: 'install', target: PLUGIN } as const

  /**
   * One Chat with the install prop wired to a flow over `service`/`feed`.
   * `notice` is what the entry reads about the package's declarations; the
   * fixtures answer it directly (reading a real dsh-plugin.json is
   * `verify-plugin-feed`'s and `verify-plugin-negotiation`'s job).
   */
  async function mountInstallChat(options: {
    readonly feed: FirstPartyFeedLoad
    readonly notice: PluginInstallNotice
    /** What one install answers; the options it was handed are the fixture's view of `approvedBuilds`. */
    readonly install: (settings: InstallBundleOptions) => Promise<ChangeResult>
    /** Defers the service's answer to `cancelInstall`: the rollback's own clock. */
    readonly cancel?: () => Promise<PluginInstallCancellation>
    /** What the service answers for one spec; the fixture's registry answer by default. */
    readonly inspect?: (spec: string) => Promise<PluginSpecInspection>
    /** The request id of the Nth install in this Chat; one fixed id by default. */
    readonly requestId?: (index: number) => PluginInstallRequestId
    /** 窄终端与全屏是终端可见改动的必测面（AGENTS.md）：默认 inline 100 列。 */
    readonly columns?: number
    readonly fullscreen?: boolean
  }) {
    const installs: InstallBundleOptions[] = []
    const installSpecs: string[] = []
    const cancels: PluginInstallRequestId[] = []
    let inspections = 0
    const service: PluginManagerView = {
      ...manager,
      inspect: (spec: string) => {
        inspections += 1
        return options.inspect?.(spec) ?? Promise.resolve(accepted)
      },
      installBundle: (spec, settings) => {
        const installOptions = settings ?? {}
        installSpecs.push(spec)
        installs.push(installOptions)
        return options.install(installOptions)
      },
      cancelInstall: requestId => {
        cancels.push(requestId)
        return options.cancel?.() ?? Promise.resolve({ status: 'cancelled' } as const)
      },
      listBundles: () => Promise.resolve(bundles),
    }
    const { term, stdin, screen, hasText, run, render } = makeHarness(options.columns ?? 100, options.fullscreen ?? false)
    const ctx = {
      on: () => () => undefined,
      get: (name: string) => name === 'pluginManager' ? service : undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    // The session's event feed is the channel's only way in, so the listeners are
    // kept: a case that needs `channel.working` starts a turn through them.
    const listeners = new Set<(events: readonly unknown[], meta: { replay: boolean }) => void>()
    const session = {
      ...createDshSession(ctx, { agent: makeAgent('plugin-install', 's-plugin-install') as never }),
      subscribe: (listener: (events: readonly unknown[], meta: { replay: boolean }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      submit: () => Promise.resolve({ accepted: true }),
    }
    const channel = createChannel(ctx, session as never, {
      model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
    })
    let flows = 0
    // The rig is the host here: it decides the layout AND hands it to the screen,
    // so the two cannot drift apart the way `fullscreen: false` let them (the
    // fullscreen case was rendering an inline Chat under a fullscreen label).
    const chatProps = {
      channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
      onExit: () => undefined, fullscreen: options.fullscreen ?? false, trajectorySeen: true,
      kernelEntries: kernelEntriesOf(listBackends()),
      onPluginInstall: (args: string, sink: PluginInstallSink) => {
        const parsed = parsePluginArgs(args)
        if (parsed.kind !== 'install' || parsed.spec === '') return undefined
        const index = flows
        flows += 1
        return createPluginInstallFlow({
          manager: service,
          spec: parsed.spec,
          feed: options.feed,
          noticeOf: () => options.notice,
          binding: sink.binding,
          busy: sink.busy,
          onLines: sink.onLines,
          requestId: options.requestId?.(index) ?? ('probe-pane' as PluginInstallRequestId),
        })
      },
    }
    const instance = await render(React.createElement(Chat, chatProps))
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    /** One turn event onto the bound session; `channel.working` follows it. */
    const turnEvent = (started: boolean): void => {
      const event = started
        ? { type: 'turn.start', turn: 1, origin: 'user', time: 1 }
        : { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 2 }
      for (const listener of listeners) listener([event], { replay: false })
    }
    return {
      installs, installSpecs, cancels, screen, hasText,
      run,
      get inspections(): number { return inspections },
      /** What the screen was actually handed (not what the case asked for). */
      chatFullscreen: (): boolean => chatProps.fullscreen === true,
      working: (): boolean => channel.working === true,
      /** Local rows titled after one report: one per push onto the bound session. */
      reportRows: (title: string): number => channel.rows.filter(row => row.text === title).length,
      turnStart: (): void => turnEvent(true),
      turnEnd: (): void => turnEvent(false),
      async enter(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\r')
      },
      async escape(): Promise<void> {
        await sleep(100) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（提交命令那次 Enter 会刷新它）
        stdin.write('\x1b')
      },
      async done(): Promise<void> { instance.unmount(); channel.releaseContributions(); term.dispose() },
    }
  }

  // A first-party package whose declaration could not be read yet: gate 1 still
  // has something to say, gate 3 does not — so the pane shows the notice and no
  // trust confirmation, and Enter installs.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: a first-party package with an unreadable declaration asks before installing`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText(`To install: ${PLUGIN}@${VERSION}`)), rig.screen())
      check(`${tag}: the pane carries gate 1's notice`,
        rig.hasText('cannot be read before it lands'), rig.screen())
      check(`${tag}: a first-party package is not asked to confirm trust`,
        !rig.hasText('full trust, no sandbox'), rig.screen())
      check(`${tag}: nothing installed before the answer`, rig.installs.length === 0, String(rig.installs.length))
      await rig.enter()
      check(`${tag}: Enter installs what the pane named`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag}: the request id reaches the service`, rig.installs[0]?.requestId === 'probe-pane', JSON.stringify(rig.installs[0]))
      check(`${tag}: the pane is gone once the flow is done`, !rig.hasText('Install plugin'), rig.screen())
      // A finished install is not a cancelled one: the pane's own cleanup must
      // not ask the service to stop a request it already answered.
      check(`${tag}: a finished install never asks the service to cancel`,
        rig.cancels.length === 0 &&
        !rig.hasText(t('plugins-install-cancel-not-running')) &&
        !rig.hasText(t('plugins-install-cancelled')), `${rig.cancels.length} · ${rig.screen()}`)
    } finally {
      await rig.done()
    }
  }

  // A third-party package: the trust confirmation is the pane's reason to exist,
  // and Esc before answering installs nothing — Enter installs. Run in the three
  // layouts the screen has to survive: inline at 100 and 50 columns, and
  // fullscreen. The layout is the screen's, not just the host's: `chatFullscreen`
  // reads what Chat was handed, so a case tagged fullscreen cannot quietly test
  // an inline screen again (the pane's own frame is the same either way — what
  // `fullscreen` moves lives in the side panel and the whole-screen key paths,
  // both outside this overlay — so the wiring is the only proof there is).
  for (const [fullscreen, columns] of [[false, 100], [false, 50], [true, 100]] as const) {
    const layout = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}`
    const rig = await mountInstallChat({
      feed: noFeed,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
      columns,
      fullscreen,
    })
    try {
      check(`${tag} ${layout}: the screen was given the layout under test`,
        rig.chatFullscreen() === fullscreen, String(rig.chatFullscreen()))
      await rig.run('/plugin install verify-fresh-plugin')
      check(`${tag} ${layout}: an unlisted package is asked to confirm trust`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText('full trust, no sandbox')), rig.screen())
      check(`${tag} ${layout}: the pane names the package it is about to install`,
        rig.hasText('To install:') && rig.hasText(PLUGIN), rig.screen())
      check(`${tag} ${layout}: the trust pane says the package will not auto-update`,
        rig.hasText('will not auto-update'), rig.screen())
      check(`${tag} ${layout}: the pane keeps its key hint on screen`,
        rig.hasText('esc cancel'), rig.screen())
      await rig.escape()
      check(`${tag} ${layout}: Esc on the confirmation closes the pane`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
      check(`${tag} ${layout}: Esc on the confirmation installs nothing`,
        rig.installs.length === 0, String(rig.installs.length))
      // The positive half in the same layout: the pane's Enter is what installs.
      await rig.run('/plugin install verify-fresh-plugin')
      check(`${tag} ${layout}: the pane comes back for the answer`,
        await settled(() => rig.hasText('Install plugin')), rig.screen())
      await rig.enter()
      check(`${tag} ${layout}: Enter installs what the pane named, in this layout`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag} ${layout}: the install ran once, in this layout`,
        rig.installs.length === 1 && rig.installSpecs[0] === `${PLUGIN}@${VERSION}`,
        `${rig.installs.length} · ${JSON.stringify(rig.installSpecs)}`)
    } finally {
      await rig.done()
    }
  }

  // Esc while the install is in flight: the pane's busy branch is the seam that
  // hands the run to `cancelInstall`, and the answer is reported once.
  {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => {
        resolveInstall?.({ ...CHANGE, application: 'cancelled' })
        return Promise.resolve({ status: 'cancelled' })
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the install is in flight before Esc`, await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      check(`${tag}: Esc mid-install asks the service to stop that request`,
        await settled(() => rig.cancels.length === 1 && rig.cancels[0] === 'probe-pane'), JSON.stringify(rig.cancels))
      check(`${tag}: the cancellation reads as one line`,
        await settled(() => rig.screen().includes(t('plugins-install-cancelled'))), rig.screen())
      check(`${tag}: the pane closes once the service confirms the cancellation`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // Two Escs, one rollback, at the screen level: the pane is the only place the
  // cancellation can be watched from, and it must stay until the service says
  // the profile is back — closing it early hands the prompt back over work that
  // is still going on.
  {
    let resolveCancel: ((value: PluginInstallCancellation) => void) | undefined
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => new Promise<PluginInstallCancellation>(resolve => { resolveCancel = resolve }),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the install is in flight before the first Esc`,
        await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      check(`${tag}: the first Esc hands the run to the service`,
        await settled(() => rig.cancels.length === 1), JSON.stringify(rig.cancels))
      await rig.escape()
      // 固定窗:探针 断言「状态不得改变」：第二次 Esc 唯一被允许的效果就是等待，
      // 它没有可轮询的完成条件，所以只能等一个观察窗再断言面板仍在。断言紧贴
      // 按键读屏是假绿：错误基线上 `cancel()` 立刻 done，Chat 关面板、还输入，
      // 但那次关闭要经 React → 节流渲染（16ms 帧）→ xterm 异步解析才落到屏幕，
      // 立即读到的仍是关屏之前的旧帧——缺陷在断言眼下发生。窗口要覆盖那条链，
      // 250ms 约十五帧，慢 runner 上也不会读到旧屏幕。
      await sleep(250)
      check(`${tag}: a second Esc does not close the pane over the rollback`,
        rig.hasText('Install plugin') && rig.cancels.length === 1,
        `${JSON.stringify(rig.cancels)} · ${rig.screen()}`)
      resolveCancel?.({ status: 'cancelled' })
      resolveInstall?.({ ...CHANGE, application: 'cancelled' })
      check(`${tag}: the pane closes once the rollback is back`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // The applying phase cannot be cancelled. Its immediate too-late response
  // leaves the pane busy until the original install settles, in both layouts.
  for (const fullscreen of [false, true]) {
    let resolveInstall: ((result: ChangeResult) => void) | undefined
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => new Promise<ChangeResult>(resolve => { resolveInstall = resolve }),
      cancel: () => Promise.resolve({ status: 'too-late' }),
      fullscreen,
      columns: 50,
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: applying is in flight before Esc (fullscreen=${fullscreen})`,
        await settled(() => rig.installs.length === 1), rig.screen())
      await rig.escape()
      // 固定窗:探针 the forbidden pane close must have time to render before
      // this negative assertion; reading the pre-Esc frame would pass falsely.
      await sleep(250)
      check(`${tag}: too-late keeps the narrow pane open (fullscreen=${fullscreen})`,
        rig.cancels.length === 1 && rig.hasText('Install plugin'), rig.screen())
      resolveInstall?.(CHANGE)
      check(`${tag}: the applying result closes the pane (fullscreen=${fullscreen})`,
        await settled(() => !rig.hasText('Install plugin') && rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
    } finally {
      resolveInstall?.(CHANGE)
      await rig.done()
    }
  }

  // Build scripts: the service blocks the install, the pane asks which ones to
  // allow, and Enter retries with exactly those.
  {
    let attempt = 0
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: () => {
        attempt += 1
        return Promise.resolve(attempt === 1
          ? { ...CHANGE, application: 'failed', pendingBuilds: ['esbuild'] }
          : CHANGE)
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: blocked build scripts are asked about in the pane`,
        await settled(() => rig.hasText('These build scripts need approval') && rig.hasText('esbuild')), rig.screen())
      check(`${tag}: the pane names the scripts it will allow`,
        await settled(() => rig.hasText('allow these scripts and retry')), rig.screen())
      await rig.enter()
      check(`${tag}: Enter retries the install with those scripts approved`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
      check(`${tag}: the retry carries the approved build scripts`,
        rig.installs.length === 2 && JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild"]',
        JSON.stringify(rig.installs))
    } finally {
      await rig.done()
    }
  }

  // The approval is spent the moment the service takes it: it is written into
  // the profile before pnpm runs (and echoed back as `result.approvedBuilds`),
  // and a name that is no longer pending is refused as `stale-approval`. So a
  // component that turns out to be incompatible has to be risked with an
  // approval that already landed — offering it again would refuse the retry and
  // leave the install unfinishable. The fixture enforces the service's own rule,
  // so losing this cannot pass as a green retry.
  {
    const allowed = new Set<string>()
    let attempt = 0
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'declared' },
      install: settings => {
        attempt += 1
        const approved = settings.approvedBuilds ?? []
        if (approved.some(name => allowed.has(name))) {
          return Promise.resolve({ ...CHANGE, application: 'failed', error: { code: 'stale-approval' } })
        }
        for (const name of approved) allowed.add(name)
        if (attempt === 1) {
          return Promise.resolve({
            ...CHANGE,
            application: 'failed',
            error: { code: 'operation-error', diagnostic: 'Ignored build scripts: esbuild' },
            pendingBuilds: ['esbuild'],
          })
        }
        if (attempt === 2) {
          return Promise.resolve({
            ...CHANGE,
            application: 'failed',
            approvedBuilds: [...approved],
            error: {
              code: 'incompatible-version',
              incompatible: [{
                name: 'probe-component', version: '1.0.0', runtimeVersion: '0.2.0-rc.2',
                peers: { '@deepseek-ai/dsh': '>=99.0.0' },
              }],
            },
          })
        }
        return Promise.resolve(CHANGE)
      },
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag}: the blocked build scripts come first`,
        await settled(() => rig.hasText('These build scripts need approval')), rig.screen())
      await rig.enter()
      check(`${tag}: the approved scripts reach the service once`,
        await settled(() => rig.installs.length === 2 &&
          JSON.stringify(rig.installs[1]?.approvedBuilds) === '["esbuild"]'), JSON.stringify(rig.installs))
      check(`${tag}: an incompatible component is reported after the approval landed`,
        await settled(() => rig.hasText('Incompatible packages:') && rig.hasText('probe-component')), rig.screen())
      await rig.enter()
      check(`${tag}: the retry after a risk does not resubmit the spent approval`,
        await settled(() => rig.installs.length === 3 && rig.installs[2]?.approvedBuilds === undefined),
        JSON.stringify(rig.installs))
      check(`${tag}: the install finishes once the risk is accepted`,
        await settled(() => rig.hasText(`Installed ${PLUGIN}`)), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // A bare name that hits the feed is still asked about: the feed vouches for one
  // exact artifact, and a bare name means "latest" at install time.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      await rig.run(`/plugin install ${PLUGIN}`)
      check(`${tag}: a bare name that hits the feed is confirmed, not trusted`,
        await settled(() => rig.hasText('Install plugin') && rig.hasText('full trust, no sandbox')), rig.screen())
      check(`${tag}: a bare name installs nothing before the answer`,
        rig.installs.length === 0, String(rig.installs.length))
      await rig.enter()
      check(`${tag}: confirming a bare name installs the exact version that was inspected`,
        await settled(() => rig.installSpecs[0] === `${PLUGIN}@${VERSION}`), JSON.stringify(rig.installSpecs))
    } finally {
      await rig.done()
    }
  }

  // Two flows, one pane: the first flow's late answer must not answer for the
  // second. It used to close B's pane and take B's cancellation with it.
  {
    let resolveA: ((inspection: PluginSpecInspection) => void) | undefined
    let resolveB: ((result: ChangeResult) => void) | undefined
    const acceptedB = {
      status: 'accepted', kind: 'registry', name: 'probe-b', version: '1.0.0',
      bundle: true, registry: null,
    } as const
    const rig = await mountInstallChat({
      feed: noFeed,
      notice: { kind: 'unjudged' },
      inspect: spec => spec === 'probe-a'
        ? new Promise<PluginSpecInspection>(resolve => { resolveA = resolve })
        : Promise.resolve(acceptedB),
      install: () => new Promise<ChangeResult>(resolve => { resolveB = resolve }),
      requestId: index => (index === 0 ? 'probe-race-a' : 'probe-race-b') as PluginInstallRequestId,
    })
    try {
      await rig.run('/plugin install probe-a')
      check(`${tag} race: the first inspection is still in flight`,
        await settled(() => rig.hasText('Installing')), rig.screen())
      await rig.escape()
      check(`${tag} race: Esc closes the flow that asked`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
      await rig.run('/plugin install probe-b')
      check(`${tag} race: the second flow asks its own question`,
        await settled(() => rig.hasText('To install: probe-b@1.0.0')), rig.screen())
      await rig.enter()
      check(`${tag} race: the second install is in flight`, await settled(() => rig.installs.length === 1), rig.screen())
      resolveA?.({ status: 'accepted', kind: 'registry', name: 'probe-a', version: '1.0.0', bundle: true, registry: null })
      // The late answer settles the first flow only: the second keeps its pane
      // (where its cancellation lives) and never touches A's request id.
      check(`${tag} race: a late answer from the first flow leaves the second alone`,
        await settled(() => rig.hasText('Installing') && rig.cancels.length === 0), rig.screen())
      await rig.escape()
      check(`${tag} race: the second flow is still cancellable, by its own id`,
        await settled(() => JSON.stringify(rig.cancels) === JSON.stringify(['probe-race-b'])), JSON.stringify(rig.cancels))
      resolveB?.({ ...CHANGE, application: 'cancelled' })
      check(`${tag} race: the cancelled install closes the pane`,
        await settled(() => !rig.hasText('Install plugin')), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // A running turn: the install reaches no service at all, and the same command
  // works once the turn is over.
  {
    const rig = await mountInstallChat({
      feed: firstParty,
      notice: { kind: 'unjudged' },
      install: () => Promise.resolve(CHANGE),
    })
    try {
      rig.turnStart()
      check(`${tag} working: the turn is running`, await settled(() => rig.working()), String(rig.working()))
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag} working: the refusal lands before any service call`,
        await settled(() => rig.hasText(t('plugins-install-busy')))
        && rig.inspections === 0 && rig.installs.length === 0,
        `${rig.inspections} · ${rig.installs.length} · ${rig.screen()}`)
      check(`${tag} working: no pane is left behind`, !rig.hasText('Install plugin'), rig.screen())
      // The gate belongs to the install subcommand alone: the read-only report
      // still answers while the turn runs.
      await rig.run('/plugin list')
      check(`${tag} working: the diagnostics command still reports`,
        await settled(() => rig.reportRows('/plugin') === 1), `${rig.reportRows('/plugin')} · ${rig.screen()}`)
      rig.turnEnd()
      check(`${tag} working: the turn is over`, await settled(() => !rig.working()), String(rig.working()))
      await sleep(150) // 固定窗:墙钟 等共享的 80ms 模态 Enter 冷却到期（上一条命令的 Enter 刷新了它）
      await rig.run(`/plugin install ${PLUGIN}@${VERSION}`)
      check(`${tag} working: the same command asks once the turn is over`,
        await settled(() => rig.hasText(`To install: ${PLUGIN}@${VERSION}`)), rig.screen())
      await rig.enter()
      check(`${tag} working: and installs`, await settled(() => rig.installs.length === 1), rig.screen())
    } finally {
      await rig.done()
    }
  }

  // The target is foreign text: a package manifest is a local file, so its name
  // can carry newlines, ANSI and thousands of cells. The confirmation must keep
  // its own title, target and key hint inside the viewport, and must not let the
  // name become rows of its own.
  {
    const hostile = `probe\nINJECTED-ROW\n\u001b[31mRED\u001b[0m-${'宽'.repeat(1200)}`
    for (const columns of [100, 50] as const) {
      const rig = makeHarness(columns, false)
      const app = await rig.render(React.createElement(PluginInstallPane, {
        busy: false,
        step: {
          kind: 'confirm',
          artifact: { name: hostile, version: '1.0.0', kind: 'path', bundle: null, registry: null },
          trust: { kind: 'third-party', reason: 'unverifiable-source' },
          notice: { kind: 'unjudged' },
        } as never,
      }))
      try {
        await sleep(300) // 固定窗:pacing 首帧渲染完再读屏（无头终端一次节流渲染的窗口）
        const lines = rig.screen().split('\n')
        check(`${tag} ${columns} columns: the confirmation keeps its title`,
          rig.hasText('Install plugin'), rig.screen())
        check(`${tag} ${columns} columns: the target and the key hint stay readable`,
          rig.hasText('To install: probe') && rig.hasText('esc cancel'), rig.screen())
        check(`${tag} ${columns} columns: a newline in the name cannot add a row of its own`,
          !lines.some(line => line.trim() === 'INJECTED-ROW'), rig.screen())
        check(`${tag} ${columns} columns: the target stays a bounded band of rows`,
          lines.filter(line => line.includes('宽')).length <= 3,
          `${lines.filter(line => line.includes('宽')).length} · ${rig.screen()}`)
      } finally {
        app.unmount()
        rig.term.dispose()
      }
    }
  }
}

// ── The production wiring, driven for real (C-4) ─────────────────────────────
// Everything above hands the flow a fixture feed and a fixture notice. This
// section drives `createPluginInstallEntry` — the function the entry itself
// passes to Chat — so the parts that only exist in the wiring are covered too:
// the packaged feed as shipped, gate 1's declaration read from the target
// directory, and the path forms the service accepts for a `install <path>` spec.
{
  const tag = 'install entry'
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
  const acceptedRegistry = {
    status: 'accepted', kind: 'registry', name: manifest.name, version: manifest.version,
    bundle: true, registry: null,
  } as const

  function entryCtx(options: { readonly manager?: boolean; readonly baseUrl?: string } = {}) {
    const service: PluginManagerView = {
      ...manager,
      // The real service's own contract, which a fixture has to obey or it proves
      // nothing: an absolute path — bare, or behind pnpm's `file:` / `link:` — is
      // read from the directory, a relative one is refused as `invalid-spec`
      // before anything reads it, and anything else is a registry name.
      inspect: (spec: string) => {
        const path = spec.replace(/^(?:file|link):/u, '')
        if (path.startsWith('/')) {
          return Promise.resolve(path.endsWith('.tgz')
            ? { status: 'accepted', kind: 'tarball', bundle: null, registry: null } as const
            : { status: 'accepted', kind: 'path', name: manifest.name, version: manifest.version, bundle: true, registry: null } as const)
        }
        if (path.startsWith('.')) {
          return Promise.resolve({ status: 'refused', problem: 'invalid-spec', reason: 'a local path must be absolute' } as const)
        }
        return Promise.resolve(acceptedRegistry)
      },
      installBundle: () => Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: manifest.name }),
      listBundles: () => Promise.resolve([]),
    }
    return {
      on: () => () => undefined,
      get: (name: string) => name === 'pluginManager' && options.manager !== false ? service : undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      ...options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
    } as never
  }
  const sink = { binding: () => 0, busy: () => false, onLines: () => undefined }

  // No service: the entry hands back no flow, and the screen falls back to the
  // report (which is where the CLI route is printed).
  const noService = createPluginInstallEntry(entryCtx({ manager: false }), { profileName: 'probe', ownVersion: manifest.version })
  check(`${tag}: with no plugin service the entry offers no flow`,
    noService('install verify-fresh-plugin', sink) === undefined)
  check(`${tag}: an argument that is not an install form offers no flow`,
    createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })('list', sink) === undefined)
  check(`${tag}: a bare install offers no flow (the report answers its usage)`,
    createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })('install', sink) === undefined)

  // The real wiring, the real packaged feed, and this very package's own pin: the
  // feed vouches for the exact version the spec names (first-party) while the
  // declaration is unreadable before the install, so gate 1 still asks.
  const own = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })(
    `install ${manifest.name}@${manifest.version}`, sink)
  check(`${tag}: the entry builds a flow for an install form`, own !== undefined)
  if (own !== undefined) {
    const step = await own.begin()
    check(`${tag}: the shipped feed vouches for the package it pins (read through the real loader)`,
      step.kind === 'confirm' && step.trust.kind === 'first-party' && step.trust.entry.name === manifest.name,
      JSON.stringify(step))
    check(`${tag}: gate 1 still asks when the declaration cannot be read yet`,
      step.kind === 'confirm' && step.notice.kind === 'unjudged', JSON.stringify(step))
    own.dispose()
  }

  // The same name without a version is a different question: "latest" is not the
  // artifact the feed pinned (`tui-profile/feed/README.md`), even though the
  // registry resolves it to the pinned version right now.
  {
    const bare = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })(
      `install ${manifest.name}`, sink)
    const step = await bare?.begin()
    check(`${tag}: a bare name never earns the feed's trust, whatever it resolves to`,
      step?.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'version-mismatch',
      JSON.stringify(step))
    bare?.dispose()
  }

  // Gate 1 reads the target's own directory and nothing else: an old same-name
  // package the profile can resolve must not answer for a new target, and the
  // target's own declaration must be read when it has one.
  {
    const root = mkdtempSync(join(tmpdir(), 'dsh-install-shadow-'))
    const profile = join(root, 'profile')
    const target = join(root, 'new-target')
    const old = join(root, 'node_modules', '@probe', 'same-name')
    for (const dir of [profile, target, old]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'probe-profile', dependencies: {} }))
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@probe/same-name', version: '2.0.0', dsh: { bundle: {} } }))
    writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@probe/same-name', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(old, 'dsh-plugin.json'), '{bad-old-declaration')
    const factory = createPluginInstallEntry(
      entryCtx({ baseUrl: pathToFileURL(`${profile}/`).href }),
      { profileName: 'probe', ownVersion: manifest.version },
    )
    const shadowed = factory(`install ${target}`, sink)
    const step = await shadowed?.begin()
    check(`${tag}: an old same-name package does not answer for a new target`,
      step?.kind === 'confirm' && step.notice.kind === 'undeclared', JSON.stringify(step))
    shadowed?.dispose()
    // …and the evidence is the target's own file when there is one.
    writeFileSync(join(target, 'dsh-plugin.json'), '{not-a-declaration-either')
    const declared = factory(`install ${target}`, sink)
    const declaredStep = await declared?.begin()
    check(`${tag}: the target's own declaration is the one that is judged`,
      declaredStep?.kind === 'confirm' && declaredStep.notice.kind === 'invalid', JSON.stringify(declaredStep))
    declared?.dispose()
  }

  // A `install <path>` spec in each form the service accepts: a bare absolute
  // path, and pnpm's `file:` / `link:` spellings of the same directory. They must
  // be judged alike — a prefix used to lose the declaration evidence behind it —
  // and a relative one is refused before any of this, so it never reaches here.
  {
    const root = mkdtempSync(join(tmpdir(), 'dsh-install-entry-'))
    const directory = join(root, 'probe-plugin-dir')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(root, 'probe.plugin.tgz'), '')
    const factory = createPluginInstallEntry(entryCtx(), { profileName: 'probe', ownVersion: manifest.version })

    for (const [label, spec] of [
      ['a bare absolute path', directory],
      ['a file: path', `file:${directory}`],
      ['a link: path', `link:${directory}`],
    ] as const) {
      const flow = factory(`install ${spec}`, sink)
      const step = await flow?.begin()
      check(`${tag}: ${label} is judged undeclared`,
        step?.kind === 'confirm' && step.notice.kind === 'undeclared', JSON.stringify(step))
      check(`${tag}: ${label} is never first-party, whatever its manifest claims`,
        step?.kind === 'confirm' && step.trust.kind === 'third-party' && step.trust.reason === 'unverifiable-source',
        JSON.stringify(step))
      flow?.dispose()
    }

    const tarball = factory(`install ${join(root, 'probe.plugin.tgz')}`, sink)
    const fileStep = await tarball?.begin()
    check(`${tag}: a spec that is not a directory stays unjudged, never "declares nothing"`,
      fileStep?.kind === 'confirm' && fileStep.notice.kind === 'unjudged', JSON.stringify(fileStep))
    tarball?.dispose()
    const missing = factory(`install ${join(root, 'no-such-directory')}`, sink)
    check(`${tag}: a spec for a directory that is not there is unjudged too`,
      (await missing?.begin())?.kind === 'confirm', 'expected a decision, not a silent install')
    missing?.dispose()
    for (const relative of ['./probe-plugin-dir', 'file:./probe-plugin-dir', 'link:./probe-plugin-dir']) {
      const flow = factory(`install ${relative}`, sink)
      check(`${tag}: ${relative} is refused as the service refuses it, not resolved here`,
        (await flow?.begin())?.kind === 'done', 'a relative path is `invalid-spec` upstream')
      flow?.dispose()
    }
  }
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
