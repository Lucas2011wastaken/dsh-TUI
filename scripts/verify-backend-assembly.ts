/**
 * The D-1 assembly point (src/dsh-adapter/backend-assembly.ts) on a real Cordis
 * composition: the bundles a profile declares in `dsh.profile.bundles` become
 * registry entries — admitted, registered and offered to the picker — without any
 * fiber ever activating, and before anything parses a backend choice.
 *
 * The cases pin the three admission states that reach the registry, the refusal
 * policy (loud, attributable to its bundle, contained), the resolution rule #1568
 * established (the Loader's own resolver, and a refusal to guess without it), the
 * fixed facts of a third-party entry (`inTree: false`, literal label, no
 * `alwaysAvailable` / `nativeKey` / `backendExport` of its own), the laziness of
 * the module import and of the pool hook, and the timing contract in both
 * directions: a boot that parsed first reads the installed id as unknown, so the
 * child case runs exactly that baseline.
 *
 * fake-home must load first: the effect ledger and the data dir resolve
 * `~/.dsh-tui` at import time.
 *
 * Run: node --import tsx/esm scripts/verify-backend-assembly.ts
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：DATA_DIR/effect-ledger 在 import 时定死

const { Context } = await import('@deepseek-ai/cordis')
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { assembleBackendsFromProfile } = await import('../src/dsh-adapter/backend-assembly.js')
const { listBackends, listOfferedBackends, loadBackend, parseBackendChoice, unloadBackends } = await import('../src/dsh-adapter/backend-registry.js')
const { kernelEntriesOf } = await import('../src/components/kernelCatalog.js')
const { assertBackendHandler } = await import('../src/adapter/spec/tui-contributions.js')
type KernelBackendId = import('../src/kernelPrefs.js').KernelBackendId

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-backend-assembly-'))
/** The profile directory the Loader resolves specifiers against (`Context.baseUrl`). */
const profileDir = join(dir, 'profile')
const PROFILE_URL = pathToFileURL(profileDir).href + '/'
const AGENT_ID = 'example-agent'
const DEGRADED_ID = 'example-degraded-agent'
const WAITING_ID = 'example-waiting-agent'
const CLI_ID = 'example-cli-agent'
const PAIR_ID = 'example-pair'
const NO_EXPORT_ID = 'example-no-export-agent'
const BAD_UNLOAD_ID = 'example-bad-unload-agent'

/**
 * The entry module of a fake backend bundle: the handler the registry reads (its
 * default export name is `backend`), its pool hook, and a marker file written when
 * the module is evaluated — one evaluation per instance, which is what makes
 * laziness and "one instance" observable from outside.
 */
const ENTRY = `import { writeFileSync } from 'node:fs'
let closed = 0
writeFileSync(new URL('./imported.txt', import.meta.url), '1')
export const backend = {
  id: 'entry-handler',
  detect: async () => undefined,
  open: async () => undefined,
}
export function closeDemoPool() {
  closed += 1
  writeFileSync(new URL('./closed.txt', import.meta.url), String(closed))
}
export default function plugin() {}
`

/** One contribution entry, in the declared shape (`apiVersion` + `kind` + `name` + `spec`). */
function contribution(spec: Record<string, unknown>, apiVersion = 'tui.dsh/v1alpha1'): Record<string, unknown> {
  return { apiVersion, kind: 'Backend', id: 'com.example.' + String(spec.id), name: 'example_backend', spec }
}

/** A package-root `dsh-plugin.json` carrying `contributions`. */
function declarationOf(contributions: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15',
    id: 'com.example.backend-bundle',
    name: 'Backend Bundle',
    version: '0.1.0',
    facets: { host: { entry: 'main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes: { commands: [], 'x-dsh-tui': contributions },
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/verify-backend-assembly' },
  }, null, 2)
}

/**
 * Write one installed bundle under the profile's `node_modules`: a package.json
 * that makes it a profile layer (`dsh.bundle`), an optional declaration, and the
 * entry module. `undefined` models a bundle that is not a TUI plugin at all.
 */
function writeBundle(
  name: string,
  contributions: readonly Record<string, unknown>[] | undefined,
  entry: string = ENTRY,
): string {
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': './main.js' },
  }, null, 2))
  if (contributions !== undefined) writeFileSync(join(packageDir, 'dsh-plugin.json'), declarationOf(contributions))
  writeFileSync(join(packageDir, 'main.js'), entry)
  return packageDir
}

const DEMO = '@dsh-tui-verify/backend-demo'
const DEGRADED = '@dsh-tui-verify/backend-degraded'
const WAITING = '@dsh-tui-verify/backend-waiting'
const RESERVED = '@dsh-tui-verify/backend-reserved'
const INVALID = '@dsh-tui-verify/backend-invalid'
const WRONG_API = '@dsh-tui-verify/backend-wrong-api'
const NOT_A_PLUGIN = '@dsh-tui-verify/plain-dependency'
const CLI = '@dsh-tui-verify/backend-cli'
const PAIR = '@dsh-tui-verify/backend-pair'
const NO_EXPORT = '@dsh-tui-verify/backend-no-export'
const BAD_UNLOAD = '@dsh-tui-verify/backend-bad-unload'
const ABSENT = '@dsh-tui-verify/declared-but-missing'
/** The D-5 dogfood bundle: a checked-in package written against the published
 *  surface, installed into the throwaway profile exactly as a person's install
 *  would leave it. */
const FIXTURE = '@dsh-tui-fixtures/echo-backend'
const FIXTURE_AGENT_ID = 'echo-agent'
const fixtureDir = join(profileDir, 'node_modules', ...FIXTURE.split('/'))
mkdirSync(dirname(fixtureDir), { recursive: true })
cpSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'third-party-backend'), fixtureDir, { recursive: true })

const demoDir = writeBundle(DEMO, [contribution({
  id: AGENT_ID,
  label: { text: 'Demo Agent' },
  shortLabel: 'Demo',
  product: 'demo-product',
  capabilities: ['permissions', 'models'],
  grants: [],
  install: { executor: 'pnpm-profile-add', specifier: '@example/agent-sdk@1.2.3', version: '1.2.3' },
  unloadExport: 'closeDemoPool',
})])
const degradedDir = writeBundle(DEGRADED, [contribution({
  id: DEGRADED_ID,
  label: { text: 'Degraded Agent' },
  shortLabel: 'Degraded',
  capabilities: ['permissions', 'time-travel'],
  grants: [],
})])
writeBundle(WAITING, [contribution({
  id: WAITING_ID,
  label: { text: 'Waiting Agent' },
  shortLabel: 'Waiting',
  capabilities: [],
  grants: ['storage.local.read'],
})])
writeBundle(RESERVED, [contribution({
  id: 'claude',
  label: { text: 'Impostor' },
  shortLabel: 'Impostor',
  capabilities: [],
  grants: [],
})])
writeBundle(INVALID, [{
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Backend',
  id: 'com.example.invalid',
  name: 'example_backend',
  spec: {
    id: 'example-invalid-agent',
    label: { text: 'Invalid Agent' },
    shortLabel: 'Invalid',
    capabilities: [],
    grants: [],
    // In-tree only, and refused as an unknown field by the family validator.
    nativeKey: 'example',
  },
}])
writeBundle(WRONG_API, [contribution({
  id: 'example-future-agent',
  label: { text: 'Future Agent' },
  shortLabel: 'Future',
  capabilities: [],
  grants: [],
}, 'tui.dsh/v2alpha1')])
writeBundle(NOT_A_PLUGIN, undefined)
const cliDir = writeBundle(CLI, [contribution({
  id: CLI_ID,
  label: { text: 'CLI Agent' },
  shortLabel: 'CLI',
  capabilities: [],
  grants: [],
  unloadExport: 'closeDemoPool',
})])
writeBundle(PAIR, [
  contribution({ id: PAIR_ID + '-one', label: { text: 'Pair One' }, shortLabel: 'Pair', capabilities: [], grants: [] }),
  contribution({ id: PAIR_ID + '-two', label: { text: 'Pair Two' }, shortLabel: 'Pair', capabilities: [], grants: [] }),
])
writeBundle(NO_EXPORT, [contribution({
  id: NO_EXPORT_ID,
  label: { text: 'No Export Agent' },
  shortLabel: 'No Export',
  capabilities: [],
  grants: [],
})], 'export default function plugin() {}\n')
writeBundle(BAD_UNLOAD, [contribution({
  id: BAD_UNLOAD_ID,
  label: { text: 'Bad Unload Agent' },
  shortLabel: 'Bad Unload',
  capabilities: [],
  grants: [],
  unloadExport: 'closeSomethingElse',
})], 'export const backend = { id: "entry-handler", detect: async () => undefined, open: async () => undefined }\n')

const COMPOSITION_OWNED = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']
const BUNDLES = [
  ...COMPOSITION_OWNED,
  FIXTURE, DEMO, DEGRADED, WAITING, RESERVED, INVALID, WRONG_API, NOT_A_PLUGIN, CLI, PAIR, NO_EXPORT, BAD_UNLOAD, ABSENT,
]
/** Registered in scan order: one bundle may declare several backends. */
const EXPECTED_REGISTERED = [
  FIXTURE_AGENT_ID, AGENT_ID, DEGRADED_ID, WAITING_ID, CLI_ID,
  PAIR_ID + '-one', PAIR_ID + '-two', NO_EXPORT_ID, BAD_UNLOAD_ID,
]
/** Bundles whose declaration announced a backend that could not become an entry. */
const EXPECTED_REFUSED = [RESERVED, INVALID, WRONG_API, ABSENT]

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-verify-backend-assembly',
  private: true,
  dependencies: Object.fromEntries(BUNDLES.map(name => [name, '0.1.0'])),
  dsh: { profile: { bundles: BUNDLES, patchReload: 'live' } },
}, null, 2))

interface Composition {
  root: InstanceType<typeof Context>
  warnings: string[]
}

/** A real composition: a Loader based at the profile directory, and nothing else.
 *  No row is ever created — the assembly may not need one. */
async function mount(): Promise<Composition> {
  const root = new Context()
  const warnings: string[] = []
  root.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof root.logger.warn
  root.logger.info = () => undefined
  ;(root as { baseUrl?: string }).baseUrl = PROFILE_URL
  await root.plugin(Loader, { baseUrl: PROFILE_URL })
  return { root, warnings }
}

// ── child mode: the "assembled too late" baseline, in its own process ──────
// A boot that parses before it assembles reads an installed backend as unknown
// (dsh + a warning) — the failure the D1 contract exists to prevent. The child
// also shows the scan needs no activation: nothing is composed there either.
if (process.env.DSH_TUI_ASSEMBLY_CHILD === '1') {
  const composition = await mount()
  const report = process.env.DSH_TUI_ASSEMBLY_REPORT ?? join(dir, 'child.jsonl')
  writeFileSync(report, '')
  try {
    const parsedBefore = parseBackendChoice(AGENT_ID) ?? null
    const assembled = assembleBackendsFromProfile(composition.root)
    appendFileSync(report, JSON.stringify({
      parsedBefore,
      parsedAfter: parseBackendChoice(AGENT_ID) ?? null,
      registered: assembled.registered,
      scanned: assembled.scanned.length,
      warnings: composition.warnings.length,
    }) + '\n')
  } finally {
    await composition.root.fiber.dispose()
  }
  process.exit(failed === 0 ? 0 : 1)
}

// ── the assembly pass, on a profile with no composed row ───────────────────
const composition = await mount()
const assembled = assembleBackendsFromProfile(composition.root)

check('assembly reads the profile manifest this boot composes',
  assembled.profile === join(profileDir, 'package.json'), String(assembled.profile))
check('assembly scans every declared bundle except the composition\'s own',
  assembled.scanned.length === BUNDLES.length - COMPOSITION_OWNED.length
  && COMPOSITION_OWNED.every(name => !assembled.scanned.includes(name)),
  JSON.stringify(assembled.scanned))
check('assembly registers the backend of every bundle that declares one',
  JSON.stringify(assembled.registered) === JSON.stringify(EXPECTED_REGISTERED),
  JSON.stringify(assembled.registered))
check('assembly refuses exactly the unjudgeable bundles, naming each',
  JSON.stringify(assembled.refused.map(refusal => refusal.bundle)) === JSON.stringify(EXPECTED_REFUSED),
  JSON.stringify(assembled.refused))
check('the refusal of a reserved id names the reserved rule, not a rival registration',
  assembled.refused.some(refusal => refusal.bundle === RESERVED && refusal.reason.includes('reserved built-in id')),
  JSON.stringify(assembled.refused))
check('a declaration the family validator cannot read is refused, never silently dropped',
  assembled.refused.some(refusal => refusal.bundle === INVALID && refusal.reason.includes('nativeKey')),
  JSON.stringify(assembled.refused))
check('a declaration of another apiVersion is not read as this host\'s Backend',
  assembled.refused.some(refusal => refusal.bundle === WRONG_API && refusal.reason.includes('v2alpha1')),
  JSON.stringify(assembled.refused))
check('a declared bundle that is not installed is reported, not ignored',
  assembled.refused.some(refusal => refusal.bundle === ABSENT && refusal.reason.includes('entry module')),
  JSON.stringify(assembled.refused))
check('a bundle that is not a TUI plugin is scanned and passed over in silence',
  assembled.refused.every(refusal => refusal.bundle !== NOT_A_PLUGIN))
check('every refusal is attributable to its bundle and warned about once',
  assembled.refused.every(refusal => BUNDLES.includes(refusal.bundle) && refusal.reason !== '')
  && composition.warnings.length === assembled.refused.length
  && composition.warnings.every(line => line.includes('was not registered')),
  JSON.stringify(composition.warnings))

// ── the third-party entry the registry holds ───────────────────────────────
const registered = listBackends().find(entry => entry.id === AGENT_ID)
check('the declared backend is in the registry', registered !== undefined)
check('a contribution is projected as out-of-tree', registered?.manifest.inTree === false)
check('a contribution keeps its literal label, its short label and its product',
  registered?.manifest.label.kind === 'literal' && registered.manifest.label.text === 'Demo Agent'
  && registered.manifest.shortLabel === 'Demo' && registered.manifest.product === 'demo-product',
  JSON.stringify(registered?.manifest.label))
check('a contribution carries no in-tree-only fact and no backendExport of its own',
  registered?.manifest.alwaysAvailable === undefined && registered.manifest.nativeKey === undefined
  && registered.manifest.vendorPackages === undefined && registered.manifest.backendExport === undefined)
check('a declared install recipe is installable through the host\'s executor table',
  registered?.installable === true)
const cliEntry = listBackends().find(entry => entry.id === CLI_ID)
check('a declaration without an install recipe reads as "nothing to install", not as refused',
  cliEntry !== undefined && cliEntry.installable === false)

// ── the admission states, on the assembly path ─────────────────────────────
check('a clean declaration is compatible and reaches the picker',
  registered?.admission.decision === 'compatible'
  && listOfferedBackends().some(entry => entry.id === AGENT_ID))
const degraded = listBackends().find(entry => entry.id === DEGRADED_ID)
check('an unknown capability degrades the admission and still reaches the picker',
  degraded?.admission.decision === 'compatible_degraded'
  && listOfferedBackends().some(entry => entry.id === DEGRADED_ID)
  && (degraded.admission.decision === 'compatible_degraded' ? degraded.admission.missingOptional : []).includes('capability:time-travel'),
  JSON.stringify(degraded?.admission))
const waiting = listBackends().find(entry => entry.id === WAITING_ID)
check('a known but ungranted permission registers the backend without offering it',
  waiting?.admission.decision === 'waiting_authorization'
  && waiting.admission.decision === 'waiting_authorization' && waiting.admission.reasonCode === 'PERMISSION_NOT_GRANTED'
  && !listOfferedBackends().some(entry => entry.id === WAITING_ID)
  && parseBackendChoice(WAITING_ID) === WAITING_ID,
  JSON.stringify(waiting?.admission))
check('every registered third-party id is the second half of the parse',
  EXPECTED_REGISTERED.every(id => parseBackendChoice(id) === id))

// ── the picker projection ──────────────────────────────────────────────────
const rows = kernelEntriesOf(listOfferedBackends())
const row = rows.find(candidate => candidate.id === AGENT_ID)
check('the picker row carries the declared label, product and installability',
  row !== undefined && row.label.kind === 'literal' && row.label.text === 'Demo Agent'
  && row.shortLabel === 'Demo' && row.product === 'demo-product' && row.installable === true
  && row.alwaysAvailable === false,
  JSON.stringify(row))
check('an entry that waits for authorization has no picker row',
  !rows.some(candidate => candidate.id === WAITING_ID))

// ── the implementation outlet: one module, imported once, only if selected ──
const importedAt = (packageDir: string): boolean => existsSync(join(packageDir, 'imported.txt'))
check('the module of a registered backend is not imported by the assembly itself',
  !importedAt(demoDir) && !importedAt(degradedDir) && !importedAt(cliDir))

const handler = await loadBackend(AGENT_ID as KernelBackendId)
check('the default export name of a contribution is `backend`',
  typeof (handler as { detect?: unknown }).detect === 'function' && typeof (handler as { open?: unknown }).open === 'function',
  JSON.stringify(Object.keys(handler as object)))
check('selecting the backend imports its module', importedAt(demoDir))
check('a backend nobody selected is still never imported',
  !importedAt(degradedDir) && !importedAt(cliDir))

const namespace = await composition.root.loader.internal.import(DEMO, PROFILE_URL, {}) as { backend?: unknown }
check('the Loader and the registry hand back the same module instance',
  namespace.backend !== undefined && namespace.backend === handler)

await unloadBackends()
check('the declared unloadExport closes the pool it names',
  readFileSync(join(demoDir, 'closed.txt'), 'utf8') === '1')
await unloadBackends()
check('a second unload is a no-op', readFileSync(join(demoDir, 'closed.txt'), 'utf8') === '1')
check('an entry that was never loaded never has its pool closed',
  !existsSync(join(cliDir, 'closed.txt')))

/** The registry's two load-path refusals, as the person who installed the bundle sees them. */
async function loadFailure(id: string): Promise<string> {
  try {
    await loadBackend(id as KernelBackendId)
    return ''
  } catch (error) {
    return messageOf(error)
  }
}
const noExportFailure = await loadFailure(NO_EXPORT_ID)
check('a module without the handler export fails loudly, naming the export it looked for',
  noExportFailure.includes('does not export "backend"'), noExportFailure)
const badUnloadFailure = await loadFailure(BAD_UNLOAD_ID)
check('a declared unloadExport the module does not carry fails loudly',
  badUnloadFailure.includes('closeSomethingElse'), badUnloadFailure)

// ── the D-5 dogfood bundle, as installed ────────────────────────────────────
// The fixture is a real package on disk (scripts/fixtures/third-party-backend),
// copied into the profile untouched: whatever it gets wrong is what a community
// author would get wrong.
const fixtureEntry = listBackends().find(entry => entry.id === FIXTURE_AGENT_ID)
check('dogfood: the checked-in third-party bundle registers from its own declaration',
  fixtureEntry !== undefined && fixtureEntry.admission.decision === 'compatible',
  JSON.stringify(fixtureEntry?.admission))
check('dogfood: it reaches the picker with the literal label it declared',
  kernelEntriesOf(listOfferedBackends()).some(candidate =>
    candidate.id === FIXTURE_AGENT_ID && candidate.label.kind === 'literal'
    && candidate.label.text === 'Echo Agent' && candidate.shortLabel === 'Echo' && candidate.product === 'echo'),
  JSON.stringify(kernelEntriesOf(listOfferedBackends()).find(candidate => candidate.id === FIXTURE_AGENT_ID)))
const fixtureHandler = await loadBackend(FIXTURE_AGENT_ID as KernelBackendId)
check('dogfood: the module it exports under `backend` passes the family\'s own handler assertion',
  (() => {
    try {
      assertBackendHandler(fixtureHandler)
      return true
    } catch {
      return false
    }
  })(), JSON.stringify(Object.keys(fixtureHandler as object)))
check('dogfood: detection answers instead of throwing, and reports what the fixture really is',
  await (fixtureHandler as { detect: () => Promise<{ installed: boolean; hint?: string }> }).detect()
    .then(detection => detection.installed === false && typeof detection.hint === 'string', () => false))

// ── the pass is a no-op the second time ─────────────────────────────────────
// Two callers on purpose: the entry decides its kernel before `apply` runs, and both
// questions are registry membership. Assembling twice must not become a storm of
// "already registered".
const again = assembleBackendsFromProfile(composition.root)
check('a second pass over the same composition registers nothing and repeats no warning',
  again.registered.length === 0
  && JSON.stringify(again.refused) === JSON.stringify(assembled.refused)
  && composition.warnings.length === assembled.refused.length,
  JSON.stringify({ registered: again.registered, warned: composition.warnings.length }))

// ── the wiring of both call sites, in the real sources ─────────────────────
// The cases above prove the *function*; these prove the callers. A boot that reads
// registry membership before it assembles is the failure the D1 contract names, so
// each boot path's membership reads must all come after the assembly it runs.
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** `assembleBackendsFromProfile(ctx)`: the line each boot path runs first. */
const ASSEMBLY_CALL = 'assembleBackendsFromProfile(ctx)'
/** `parseBackendChoice()` and `isRegisteredBackend()` are the two ways `apply` asks
 *  the registry whether an id is one this process can run. */
const BOOT_READS = /parseBackendChoice\(|isRegisteredBackend\(/gu
/** The line that fixes the kernel the entry's composition boots on (its route
 *  helpers read membership indirectly, so the call is what is named here). */
const ENTRY_KERNEL_LINE = 'const kernel: KernelBackendId = entryKernel('

/** Whether `source` assembles installed backends before every read of `pattern`. */
function assemblesBeforeEvery(source: string, pattern: RegExp): boolean {
  const assembly = source.indexOf(ASSEMBLY_CALL)
  const reads = [...source.matchAll(pattern)]
  return assembly >= 0 && reads.length >= 1
    && reads.every(read => (read.index ?? 0) > assembly)
}

/** {@link assemblesBeforeEvery} against a named line instead of a pattern. */
function assemblesBeforeLine(source: string, line: string): boolean {
  const assembly = source.indexOf(ASSEMBLY_CALL)
  const read = source.indexOf(line)
  return assembly >= 0 && read > assembly
}

/** Move the assembly call to just after `line` — the "assembled too late" baseline. */
function assemblyMovedAfter(source: string, line: string): string {
  const call = `  ${ASSEMBLY_CALL}\n`
  const without = source.replace(call, '')
  const read = without.indexOf(line)
  const lineEnd = without.indexOf('\n', read) + 1
  return without.slice(0, lineEnd) + call + without.slice(lineEnd)
}

const bootSource = readFileSync(join(REPO, 'src', 'dsh-adapter', 'plugin.ts'), 'utf8')
check('the DSH boot reads registry membership only after the assembly ran',
  assemblesBeforeEvery(bootSource, BOOT_READS),
  JSON.stringify([...bootSource.matchAll(BOOT_READS)].map(read => read.index)))
check('the wiring check bites: moving the assembly after the boot\'s first read is red',
  !assemblesBeforeEvery(assemblyMovedAfter(bootSource, 'const handoffBackend = parseBackendChoice('), BOOT_READS))

const entrySource = readFileSync(join(REPO, 'src', 'dsh-adapter', 'host-entry.ts'), 'utf8')
check('the standalone entry decides its kernel only after the assembly ran',
  assemblesBeforeLine(entrySource, ENTRY_KERNEL_LINE)
  && entrySource.indexOf('entryKernel: kernel') > entrySource.indexOf(ENTRY_KERNEL_LINE),
  JSON.stringify([entrySource.indexOf(ASSEMBLY_CALL), entrySource.indexOf(ENTRY_KERNEL_LINE)]))
check('the wiring check bites: moving the assembly after the entry\'s kernel is red',
  !assemblesBeforeLine(assemblyMovedAfter(entrySource, ENTRY_KERNEL_LINE), ENTRY_KERNEL_LINE))

await composition.root.fiber.dispose()

// ── identity comes from the Loader's resolver, or from nowhere ─────────────
const without = await mount()
const savedResolver = without.root.loader.internal
without.root.loader.internal = undefined
const debugLines: string[] = []
const stderrWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  debugLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  return true
}) as typeof process.stderr.write
process.env.DSH_TUI_DEBUG = '1'
try {
  const refusedAll = assembleBackendsFromProfile(without.root)
  check('without the Loader resolver nothing is registered and nothing is guessed',
    refusedAll.registered.length === 0 && refusedAll.scanned.length === BUNDLES.length - COMPOSITION_OWNED.length,
    JSON.stringify(refusedAll.registered))
  check('without the Loader resolver the skip is explained, naming what could not be judged',
    debugLines.some(line => line.includes('ESM resolver is unavailable') && line.includes(DEMO)),
    debugLines.join(''))
  check('without the Loader resolver no bundle is blamed for it',
    without.warnings.length === 0, JSON.stringify(without.warnings))
} finally {
  delete process.env.DSH_TUI_DEBUG
  process.stderr.write = stderrWrite
  without.root.loader.internal = savedResolver
  await without.root.fiber.dispose()
}

// ── the timing contract: assembly before the parse ─────────────────────────
const childReport = join(dir, 'child-report.jsonl')
const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url)], {
  cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8', timeout: 30000,
  env: { ...process.env, DSH_TUI_ASSEMBLY_CHILD: '1', DSH_TUI_ASSEMBLY_REPORT: childReport },
})
check('timing baseline child ran', child.status === 0, child.stdout + child.stderr)
const outcome = child.status === 0
  ? JSON.parse(readFileSync(childReport, 'utf8').trim().split('\n').pop() ?? '{}') as {
      parsedBefore: string | null; parsedAfter: string | null; registered: string[]; scanned: number; warnings: number }
  : { parsedBefore: 'child failed', parsedAfter: 'child failed', registered: [], scanned: -1, warnings: -1 }
check('bad baseline: a boot that parses first reads an installed backend as unknown',
  outcome.parsedBefore === null, JSON.stringify(outcome))
check('assembly first: the same id is a registered backend by the time the boot parses',
  outcome.parsedAfter === AGENT_ID, JSON.stringify(outcome))
check('the scan needs no fiber activation: nothing was composed in the child',
  outcome.scanned === BUNDLES.length - COMPOSITION_OWNED.length
  && JSON.stringify(outcome.registered) === JSON.stringify(EXPECTED_REGISTERED), JSON.stringify(outcome))

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? 'verify-backend-assembly ALL PASS' : `verify-backend-assembly ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
