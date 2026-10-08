/**
 * The kernel catalog with the registry behind it (P0 D1/D2/D5): the entry list
 * is the registry's, in declaration order; names come from the manifests; only a
 * backend whose detection says `stale` reads "too old"; and the two-stage parse
 * (syntax, then membership) keeps every unknown value on the dsh fallback.
 *
 * Run: node --import tsx/esm scripts/verify-kernel-catalog.ts
 */
import assert from 'node:assert/strict'
import { buildKernelCatalog, kernelEntriesOf, kernelSubtitle } from '../src/components/kernelCatalog.js'
import { setLang, t } from '../src/i18n.js'
import { isBackendIdSyntax } from '../src/agent/backend-manifest.js'
import { parseBackendId, resolveRememberedBackend } from '../src/kernelPrefs.js'
import { normalizeBackendChoice } from '../src/dsh-adapter/index.js'
import { isRegisteredBackend, listBackends, parseBackendChoice } from '../src/dsh-adapter/backend-registry.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── The registry is the single source of "which backends exist" ──────────────
const backends = listBackends()
check('the seed is dsh, then the manifests in directory order', backends.map(entry => entry.id).join(',') === 'dsh,claude,codex', backends.map(entry => entry.id))
check('dsh: in-tree, always available, and not an AgentBackend (no loader)',
  backends[0]!.manifest.inTree && backends[0]!.manifest.alwaysAvailable === true && backends[0]!.load === undefined)
check('codex: label, product, short name and pool hook come from its manifest',
  backends[2]!.manifest.label.kind === 'key' && backends[2]!.manifest.label.key === 'kernel-label-codex'
    && t('kernel-label-codex') === 'Codex' && backends[2]!.manifest.product === 'codex-cli'
    && backends[2]!.manifest.shortLabel === 'Codex' && backends[2]!.manifest.unloadExport === 'closeAllCodexHubs')
check('only the Claude SDK is host-installable, and only it declares the install data',
  backends[1]!.manifest.installable === true && backends[1]!.manifest.sdkInstall?.specifier.startsWith('@anthropic-ai/claude-agent-sdk@') === true
    && backends[0]!.manifest.installable !== true && backends[2]!.manifest.installable !== true
    && backends[0]!.manifest.sdkInstall === undefined && backends[2]!.manifest.sdkInstall === undefined)

// ── The two-stage parse: syntax, then membership (D1) ────────────────────────
check('syntax gate passes a plugin-shaped id, the registry gate does not',
  isBackendIdSyntax('acme-agent') && parseBackendId(' Acme-Agent ') === 'acme-agent'
    && !isRegisteredBackend('acme-agent') && parseBackendChoice('acme-agent') === undefined)
check('codex is a registered id; --backend / DSH_TUI_BACKEND accept it (case-insensitive)',
  isRegisteredBackend('codex') && normalizeBackendChoice(' Codex ') === 'codex' && resolveRememberedBackend({ envRaw: 'codex' }) === 'codex')
check('an uninstalled-but-well-formed DSH_TUI_BACKEND falls back to dsh, never the memory',
  resolveRememberedBackend({ envRaw: 'acme-agent', memory: 'claude' }) === 'acme-agent'
    && resolveRememberedBackend({ envRaw: 'acme-agent', envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh'
    && resolveRememberedBackend({ envRaw: 'Acme Agent', envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh')

const entries = kernelEntriesOf(backends)
check('the projection carries the manifest names the picker paints',
  entries[0]!.shortLabel === 'DSH' && entries[1]!.shortLabel === 'Claude' && entries[2]!.shortLabel === 'Codex'
    && entries[1]!.label.kind === 'key' && entries[1]!.alwaysAvailable === false && entries[1]!.installable === true)

// ── Rows ─────────────────────────────────────────────────────────────────────
const probing = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true })
check('probing: dsh selectable, the others dim and "checking"', probing[0]!.selectable && probing.slice(1).every(option => !option.selectable && option.reasonKey === 'kernel-probing'))

const ready = buildKernelCatalog({ current: 'codex', entries, dshVersion: '0.2.0', statuses: { claude: { installed: true, auth: 'ok', version: '2.1.0' }, codex: { installed: true, auth: 'ok', version: '0.160.1' } } })
const codex = ready.find(option => option.id === 'codex')!
check('ready: codex selectable, current, product-prefixed version', codex.selectable && codex.current && codex.version === 'codex-cli v0.160.1' && kernelSubtitle(codex, key => t(key)) === 'codex-cli v0.160.1')

const missing = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { claude: { installed: false }, codex: { installed: false } } })
check('not installed: Claude offers the install wizard, Codex only says not installed', missing[1]!.installable === true && missing[1]!.reasonKey === 'kernel-not-installed-installable'
  && missing[2]!.installable === undefined && missing[2]!.reasonKey === 'kernel-unavailable-not-installed' && !missing[2]!.selectable)

// Too old: the *detection* says so (`stale`), not an id comparison in the UI —
// a version without the flag is an ordinary install miss (D5-2).
const tooOld = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { codex: { installed: false, stale: true, version: '0.100.0', hint: 'upgrade codex' } } })
check('too old: dim, "too old" reason and the upgrade hint carried', !tooOld[2]!.selectable && tooOld[2]!.reasonKey === 'kernel-unavailable-too-old' && tooOld[2]!.hint === 'upgrade codex', tooOld[2])
const versionOnly = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { codex: { installed: false, version: '0.100.0' } } })
check('a version without `stale` is not "too old"', versionOnly[2]!.reasonKey === 'kernel-unavailable-not-installed', versionOnly[2])

const signedOut = buildKernelCatalog({ current: 'dsh', entries, statuses: { claude: { installed: true, auth: 'missing' }, codex: { installed: true, auth: 'missing', loginInSession: true } } })
check('signed out: a row without in-session login stays dim', !signedOut[1]!.selectable && signedOut[1]!.reasonKey === 'kernel-unavailable-auth-missing')
check('signed out + loginInSession: selectable with a "sign in after start" note', signedOut[2]!.selectable && signedOut[2]!.reasonKey === undefined && signedOut[2]!.noteKey === 'kernel-login-in-session'
  && kernelSubtitle(signedOut[2]!, key => t(key)) === t('kernel-login-in-session'))

const unknownAuth = buildKernelCatalog({ current: 'dsh', entries, statuses: { codex: { installed: true, auth: 'unknown', version: '0.170.0' } } })
check('auth unknown (a keychain): selectable, no note', unknownAuth[2]!.selectable && unknownAuth[2]!.noteKey === undefined)

console.log(`\nverify-kernel-catalog OK (${passed} checks)`)
