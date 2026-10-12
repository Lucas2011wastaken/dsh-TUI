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

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { setLang, t }, { kernelEntriesOf }, { listBackends }, { findText, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/components/kernelCatalog.js'),
  import('../src/dsh-adapter/backend-registry.js'),
  import('./lib/term-test.mjs'),
])

setLang('en')
const ROWS = 40

const bundles: BundleInfo[] = [
  {
    name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', enabled: true, installed: false,
    optional: true, removable: false, rows: [], overrides: ['hmr'],
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
const manager: PluginManagerView = {
  listBundles: () => Promise.resolve(bundles),
  listPlugins: () => Promise.resolve(plugins),
  registries: () => Promise.resolve({
    registry: 'https://registry.npmjs.org/',
    fallbackRegistries: ['https://registry.npmmirror.com/'],
    resolved: null,
  }),
  inspect: spec => Promise.resolve(spec === 'verify-bad-spec'
    ? { status: 'refused', problem: 'not-found', reason: '404 Not Found' }
    : {
        status: 'accepted', kind: 'registry', name: 'verify-fresh-plugin', version: '9.9.9',
        description: 'a fresh plugin', bundle: true, registry: 'https://registry.npmjs.org/',
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

/** Only the installation-supplied bundle: the "nothing added yet" profile. */
const officialOnlyManager: PluginManagerView = {
  ...manager,
  listBundles: () => Promise.resolve(bundles.filter(bundle => !bundle.installed)),
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
] as const) {
  const tag = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}${service === 'present' ? '' : ` ${service}`}`
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
  // `/plugin` is a DSH-served command (its requirement defaults to `dsh`), so
  // the fixture is an Agent: createChannel builds the real DSH session around
  // it and attaches the DSH extensions this command lives in.
  const agent = {
    id: 'plugin-chat', status: 'idle',
    session: { id: 's-plugin-chat', seq: 0, events: [], header: {} },
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, inbox: { remove: () => true },
  }
  const ctx = {
    on: () => () => undefined,
    get: (name: string) => name === 'pluginManager' && service !== 'absent'
      ? (service === 'failing' ? failingManager : service === 'official-only' ? officialOnlyManager : manager)
      : undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never
  const channel = createChannel(ctx, agent as never, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false })
  const node = React.createElement(Chat, {
    channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(),
    onExit: () => undefined, fullscreen, trajectorySeen: true,
    kernelEntries: kernelEntriesOf(listBackends()),
  })
  const instance = await ui.render(fullscreen ? <ui.AlternateScreen mouseTracking>{node}</ui.AlternateScreen> : node, {
    stdout: new Out() as never, stdin: stdin as never, stderr: new Out() as never,
    exitOnCtrlC: false, patchConsole: false,
  })
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
    if (service === 'failing') {
      // The service rejects: the diagnostics half is intact and the failure is
      // one line of its own, not a lost report (and not an unhandled rejection).
      check(`${tag}: a failing service keeps the diagnostics and reports itself`,
        await settled(() => hasText(t('plugins-host-unavailable')) &&
          hasText(t('plugins-service-error', { err: SERVICE_FAILURE }))), screen())
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
console.log(`verify-plugin-manager-chat OK (${passed} checks)`)
