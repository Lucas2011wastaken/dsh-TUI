/**
 * /plugin diagnostics surface (C-070 trust disclosure + C-030 negotiation
 * diagnostics): assembles the lines behind the `/plugin` command.
 *
 * Sections (overview):
 *
 * 1. TRUST BANNER — always the first line (C-070): plugins run in-process;
 *    grants are behavioral constraints, not a security boundary; passing
 *    validation is not proof of safety.
 * 2. HOST DESCRIPTOR summary — what the running host actually advertises
 *    (coordinates + generation), including drift-dropped contracts.
 * 3. GRANT MATRIX — plugins × the registered permissions. The plugin set is
 *    the union of FOOTPRINTS ONLY: keys of the grants file, pluginIds seen
 *    in the effect ledger, and storage namespaces on disk. The header says so
 *    honestly. (The profile's own bundles and rows are a different question
 *    and come from the host plugin service, below — this matrix stays the
 *    footprint view it has always been.)
 * 4. LEDGER TAIL — the last 5 effect-ledger records.
 * 5. BUNDLES AND ROWS — what the profile composes, from `ctx.pluginManager`
 *    (`./plugin-manager.ts`): official installation-supplied bundles first,
 *    then the profile's own, each with gate 1's tag from its declaration
 *    (`./plugin-declaration.ts`), plus the loader entries no patch row can
 *    address. Absent service → every line above is unchanged and one line
 *    says why the half is missing.
 *
 * `/plugin check <path>` uses the parser and projection from the pinned
 * @dsh-std/manifest revision, then evaluates every public/private protocol
 * through one ProtocolCatalog. Manifests and on-disk files are UNTRUSTED input:
 * every derived line passes cleanScalarText before it reaches the
 * transcript.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BundleInfo, PluginInfo, PluginRegistries, PluginSpecInspection } from '@deepseek-ai/dsh-plugin-manager/types'
import { parseManifest, projectManifest } from '../adapter/standard/protocols.js'
import { DATA_DIR } from '../utils/paths.js'
import { getLang, t } from '../i18n.js'
import { loadSpecData } from '../adapter/standard/registry.js'
import { createContractIndex, validatePlugin, negotiate } from '../adapter/standard/admission.js'
import type { NegotiationDecision } from '../adapter/standard/types.js'
import { cleanScalarText } from './sanitize.js'
import type { GrantStore } from '../adapter/standard/grants.js'
import type { HostDescriptorBuild } from '../adapter/standard/descriptor.js'
import { isCompositionOwned, type PluginDeclaration } from './plugin-declaration.js'
import type { PluginManagerView } from './plugin-manager.js'
import { PLUGIN_STORAGE_DIR } from './plugin-storage.js'
import { EFFECT_LEDGER_FILE } from './effect-ledger.js'

/** How many plugins the matrix shows before an overflow note. */
export const PLUGINS_MATRIX_MAX_ROWS = 20
/** How many ledger records the tail section shows. */
export const PLUGINS_LEDGER_TAIL = 5
/** Per-line cell cap for file-derived content. */
const LINE_CELLS = 200

export interface PluginsInfoDeps {
  /** Effective grant answers (the plugin-host row's store when mounted). */
  grants: GrantStore
  /** The plugin-host row's descriptor build; undefined → row not mounted. */
  host?: HostDescriptorBuild
  /** A package's declaration, resolved from the running composition. */
  declaration?: (packageName: string) => PluginDeclaration | undefined
  /** Test overrides; default under DATA_DIR. */
  dataDir?: string
  ledgerFile?: string
  storageDir?: string
}

interface LedgerLine {
  sequence?: unknown
  operation?: unknown
  pluginId?: unknown
  resource?: { kind?: unknown; id?: unknown }
  result?: unknown
  errorCode?: unknown
}

const cell = (value: unknown): string => cleanScalarText(String(value ?? ''), LINE_CELLS)

/** Parse the ledger file tolerantly (skip corrupt lines, never throw). */
function readLedgerRecords(file: string): LedgerLine[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records: LedgerLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') records.push(parsed as LedgerLine)
    } catch {
      // Corrupt line: the diagnostics surface skips it (never rewrites).
    }
  }
  return records
}

/** The plugin set for the matrix: grants-file keys ∪ ledger pluginIds ∪
 *  storage namespaces ('host'/'undeclared' ledger identities are not
 *  plugins and are excluded). */
function footprintPlugins(deps: PluginsInfoDeps, dataDir: string, ledgerFile: string, storageDir: string): string[] {
  const found = new Set<string>()
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'extension-grants.json'), 'utf8'))
    if (raw !== null && typeof raw === 'object') {
      const table = raw as { grants?: unknown; denies?: unknown }
      for (const section of [table.grants, table.denies]) {
        if (section !== null && typeof section === 'object') {
          for (const plugin of Object.keys(section)) found.add(plugin)
        }
      }
    }
  } catch {
    // Missing/corrupt grants file: the GrantStore already answers deny;
    // the matrix simply has no rows from this source.
  }
  for (const record of readLedgerRecords(ledgerFile)) {
    if (typeof record.pluginId === 'string' && record.pluginId !== '' && record.pluginId !== 'host' && record.pluginId !== 'undeclared') {
      found.add(record.pluginId)
    }
  }
  try {
    for (const entry of readdirSync(storageDir)) {
      if (!entry.endsWith('.json')) continue
      const namespace = decodeURIComponent(entry.slice(0, -'.json'.length))
      if (namespace !== '') found.add(namespace)
    }
  } catch {
    // No storage directory yet: no rows from this source.
  }
  void deps
  return [...found].sort()
}

/** `/plugin check <path>`: official parse/projection + profile validation + negotiation. */
function checkManifestLines(pathArg: string, deps: PluginsInfoDeps): string[] {
  const lines: string[] = []
  const target = resolve(pathArg)
  if (!existsSync(target)) {
    lines.push(t('plugins-check-not-found', { path: cell(pathArg) }))
    return lines
  }
  let source: string
  try {
    source = readFileSync(target, 'utf8')
  } catch (error) {
    lines.push(t('plugins-check-invalid-json', { err: cell(error instanceof Error ? error.message : String(error)) }))
    return lines
  }
  const data = loadSpecData()
  if (data === undefined) {
    lines.push(t('plugins-check-spec-unavailable'))
    return lines
  }
  let manifest
  try {
    manifest = parseManifest(source, { source: target })
    // Projection is an explicit admission stage. validatePlugin performs its
    // own defensive projection too, but keeping this call here makes parser
    // and projection failures distinguishable at the user-facing boundary.
    projectManifest(manifest)
  } catch (error) {
    const message = cell(error instanceof Error ? error.message : String(error))
    lines.push(error instanceof SyntaxError
      ? t('plugins-check-invalid-json', { err: message })
      : t('plugins-check-schema-failed', { err: message }))
    return lines
  }
  const index = createContractIndex(data.registry, data.permissions)
  try {
    validatePlugin(index, manifest)
  } catch (error) {
    lines.push(t('plugins-check-invalid', { err: cell(error instanceof Error ? error.message : String(error)) }))
    return lines
  }
  // No live host: do NOT fall back to a full advertised surface. The check
  // stays static (validation only) and explicitly reports host-unavailable /
  // non-live instead of participating in protocol support negotiation.
  const host = deps.host
  if (host === undefined) {
    lines.push(t('plugins-check-host-unavailable'))
    return lines
  }
  const granted = manifest.permissions
    .map(request => ({
      name: request.name,
      scope: request.scope,
      // `/plugin check` has no live activation instance. Passing an
      // activation-less principal makes GrantStore fail closed when policy
      // contains activation-scoped rules instead of treating them as global.
      granted: deps.grants.allows({ componentId: manifest.id }, request.name, request.scope),
    }))
  const decision = negotiate(index, manifest, host.descriptor, granted)
  lines.push(...decisionLines(decision))
  if (decision.decision === 'waiting_authorization') {
    // Close the loop on the five-state vocabulary: the user sees not just
    // the state but the exact file + shape that flips it (the interactive
    // grant flow is future work; this hint is its no-UI prerequisite).
    lines.push(t('plugins-check-grant-hint', {
      id: cell(manifest.id),
      perms: cell(decision.deniedPermissions.join(', ')),
    }))
  }
  if (host.dropped.length > 0) {
    lines.push(t('plugins-check-dropped', { dropped: cell(host.dropped.join(', ')) }))
  }
  return lines
}

/** The five-state vocabulary as one cell (shared by `check` and the list tags). */
function stateText(decision: NegotiationDecision): string {
  switch (decision.decision) {
    case 'compatible':
      return 'compatible'
    case 'compatible_degraded':
      return `compatible_degraded (missingOptional: ${cell(decision.missingOptional.join(', '))})`
    case 'waiting_authorization':
      return `waiting_authorization (${cell(decision.reasonCode)}: ${cell(decision.deniedPermissions.join(', '))})`
    case 'rejected': {
      const detail = decision.missingRequired !== undefined
        ? `${cell(decision.reasonCode)}: ${cell(decision.missingRequired.join(', '))}`
        : `${cell(decision.reasonCode)}: facet ${cell(decision.facetApiVersion)} vs host [${cell((decision.hostFacetApiVersions ?? []).join(', '))}]`
      return `rejected (${detail})`
    }
    case 'unknown':
      return `unknown (${cell(decision.reasonCode)}: ${cell(decision.unknownContracts.join(', '))})`
  }
}

function decisionLines(decision: NegotiationDecision): string[] {
  return [t('plugins-check-state', { state: stateText(decision) })]
}

/** Which form of the command the raw argument text asks for. */
export type PluginArgs =
  | { readonly kind: 'overview' }
  | { readonly kind: 'check'; readonly path: string }
  | { readonly kind: 'info'; readonly spec: string }
  | { readonly kind: 'registries' }
  | { readonly kind: 'unknown'; readonly sub: string }

/** Route `/plugin`'s argument text: one parser, so both halves of the report agree. */
export function parsePluginArgs(args: string): PluginArgs {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'overview' }
  const [sub, ...rest] = trimmed.split(/\s+/)
  if (sub === 'check') return { kind: 'check', path: rest.join(' ') }
  if (sub === 'info') return { kind: 'info', spec: rest.join(' ') }
  if (sub === 'registries') return { kind: 'registries' }
  return { kind: 'unknown', sub: sub ?? '' }
}

/** The `/plugin` overview lines (banner always first). */
export function pluginsInfoLines(args: string, deps: PluginsInfoDeps): string[] {
  const lines: string[] = [t('plugins-trust-banner')]
  const parsed = parsePluginArgs(args)
  if (parsed.kind === 'check') {
    if (parsed.path === '') {
      lines.push(t('plugins-check-usage'))
      return lines
    }
    lines.push(...checkManifestLines(parsed.path, deps))
    return lines
  }
  if (parsed.kind === 'unknown') {
    lines.push(t('plugins-unknown-subcommand', { sub: cell(parsed.sub) }))
    return lines
  }
  // `info <spec>` names what it is looking for, so a bare one is a usage error
  // the sync half can already answer; both service forms render below.
  if (parsed.kind === 'info') {
    if (parsed.spec === '') lines.push(t('plugins-info-usage'))
    return lines
  }
  if (parsed.kind === 'registries') return lines

  const dataDir = deps.dataDir ?? DATA_DIR
  const ledgerFile = deps.ledgerFile ?? EFFECT_LEDGER_FILE
  const storageDir = deps.storageDir ?? join(dataDir, PLUGIN_STORAGE_DIR)

  // ── Host Descriptor ──
  if (deps.host === undefined) {
    lines.push(t('plugins-host-unavailable'))
  } else {
    const { descriptor, dropped } = deps.host
    lines.push(`Host Descriptor: ${cell(descriptor.hostId)} v${cell(descriptor.hostVersion)} · generation ${cell(descriptor.runtime.generationId)}`)
    lines.push(`  facets: ${cell(descriptor.facetApiVersions.join(', ') || '—')}`)
    for (const contract of descriptor.contracts) {
      const definition = contract.definition.source === 'dsh-std'
        ? contract.definition.package
        : contract.definition.profileHash.slice(0, 19) + '…'
      lines.push(`  ${cell(contract.apiVersion)}#${cell(contract.kind)} · definition ${cell(definition)} · perms ${cell(contract.permissions.join(', ') || '—')}`)
    }
    for (const coordinate of dropped) {
      lines.push(`  ${cell(coordinate)} · ${t('plugins-contract-dropped')}`)
    }
  }

  // ── 授权矩阵 ──
  const plugins = footprintPlugins(deps, dataDir, ledgerFile, storageDir)
  lines.push(t('plugins-matrix-note'))
  const permissions = deps.grants.knownPermissions()
  if (permissions.length === 0) {
    lines.push(`  ${t('plugins-matrix-no-registry')}`)
  } else if (plugins.length === 0) {
    lines.push(`  ${t('plugins-matrix-empty')}`)
  } else {
    lines.push(`  ${permissions.map((permission, index) => `[${index + 1}] ${cell(permission)}`).join('  ')}`)
    const shown = plugins.slice(0, PLUGINS_MATRIX_MAX_ROWS)
    const width = Math.max(...shown.map(plugin => plugin.length), 8)
    for (const plugin of shown) {
      const diagnosticScope = (permission: string): string => {
        if (permission === 'storage.local.read' || permission === 'storage.local.write') return plugin
        if (permission === 'commands.invoke') return 'diagnostic.command'
        return 'session:*'
      }
      const marks = permissions.map(permission => (
        deps.grants.allows({ componentId: plugin }, permission, diagnosticScope(permission)) ? '✓' : '·'
      )).join(' ')
      lines.push(`  ${cell(plugin).padEnd(width)}  ${marks}`)
    }
    if (plugins.length > shown.length) {
      lines.push(`  ${t('plugins-footprint-overflow', { count: plugins.length - shown.length })}`)
    }
    // Actionable next step for the · marks (same loop-closer as the check
    // path): the file path + rule shape, so granting needs no spec reading.
    lines.push(`  ${t('plugins-grant-hint')}`)
  }

  // ── 台账尾 ──
  const records = readLedgerRecords(ledgerFile)
  if (records.length === 0) {
    lines.push(t('plugins-ledger-empty'))
  } else {
    lines.push(t('plugins-ledger-header', { file: cell(ledgerFile) }))
    for (const record of records.slice(-PLUGINS_LEDGER_TAIL)) {
      const resource = record.resource ?? {}
      lines.push(
        `  #${cell(record.sequence)} ${cell(record.operation)} ${cell(resource.kind)}/${cell(resource.id)} ` +
        `${cell(record.pluginId)} ${cell(record.result)}${typeof record.errorCode === 'string' ? ` (${cell(record.errorCode)})` : ''}`,
      )
    }
  }
  return lines
}

/**
 * What a listed package says about itself (gate 1's evidence): no declaration
 * at all, a declaration this profile cannot read, or the negotiated decision.
 */
type DeclarationVerdict =
  | { readonly kind: 'undeclared' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'decided'; readonly decision: NegotiationDecision }

/** Evaluate a package's declaration exactly as `check <path>` does. */
function declarationVerdict(deps: PluginsInfoDeps, packageName: string): DeclarationVerdict {
  const declaration = deps.declaration?.(packageName)
  if (declaration === undefined) return { kind: 'undeclared' }
  const data = loadSpecData()
  if (data === undefined) return { kind: 'invalid', error: t('plugins-check-spec-unavailable') }
  let manifest
  try {
    manifest = parseManifest(declaration.source, { source: declaration.path })
    projectManifest(manifest)
  } catch (error) {
    return { kind: 'invalid', error: cell(error instanceof Error ? error.message : String(error)) }
  }
  const index = createContractIndex(data.registry, data.permissions)
  try {
    validatePlugin(index, manifest)
  } catch (error) {
    return { kind: 'invalid', error: cell(error instanceof Error ? error.message : String(error)) }
  }
  const host = deps.host
  if (host === undefined) return { kind: 'invalid', error: t('plugins-check-host-unavailable') }
  const granted = manifest.permissions.map(request => ({
    name: request.name,
    scope: request.scope,
    granted: deps.grants.allows({ componentId: manifest.id }, request.name, request.scope),
  }))
  return { kind: 'decided', decision: negotiate(index, manifest, host.descriptor, granted) }
}

/**
 * The gate-1 tag for one listed package, or `undefined` when it needs none.
 * The composition's own rows are not plugins a person installed, so an absent
 * declaration there is the normal state rather than a finding.
 */
function declarationTag(deps: PluginsInfoDeps, packageName: string): string | undefined {
  const verdict = declarationVerdict(deps, packageName)
  switch (verdict.kind) {
    case 'undeclared':
      return isCompositionOwned(packageName) ? undefined : t('plugins-tag-undeclared')
    case 'invalid':
      return t('plugins-tag-invalid', { err: verdict.error })
    case 'decided':
      return t('plugins-tag-declared', { state: stateText(verdict.decision) })
  }
}

/** The host's localized text (`PluginLocalizedMeta.title`): a literal, or translations by language id. */
type LocalizedPluginText = string | { readonly en: string; readonly [locale: string]: string }

/** Pick a display string out of the host's localized metadata. */
function localizedText(value: LocalizedPluginText | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  return value[getLang()] ?? value.en ?? fallback
}

/**
 * Display title of one loader entry. `PluginInventoryEntry.meta` arrived after
 * the 0.1.5 line, so an older host answers the module specifier instead
 * (contract.ts: additions must degrade gracefully on the older lines), and the
 * field is read structurally for the same reason.
 */
function pluginRowTitle(plugin: PluginInfo): string {
  const meta = (plugin as { readonly meta?: { readonly title?: LocalizedPluginText } }).meta
  return cell(localizedText(meta?.title, plugin.moduleName))
}

/** One bundle row: what the profile holds, how it is controlled, what it says. */
function bundleLine(deps: PluginsInfoDeps, bundle: BundleInfo): string {
  const flags: string[] = [bundle.enabled ? t('plugins-bundle-on') : t('plugins-bundle-off')]
  if (!bundle.removable) flags.push(t('plugins-bundle-kept'))
  if (bundle.readOnlyReason !== undefined) flags.push(t('plugins-bundle-locked', { reason: cell(bundle.readOnlyReason) }))
  if (bundle.error !== undefined) flags.push(t('plugins-bundle-problem', { code: cell(bundle.error.code) }))
  const tag = declarationTag(deps, bundle.name)
  if (tag !== undefined) flags.push(tag)
  const title = cell(localizedText(bundle.meta?.title, bundle.name))
  const version = bundle.version === undefined ? '' : ` ${cell(bundle.version)}`
  const rows = t('plugins-bundle-rows', { rows: String(bundle.rows.length), overrides: String(bundle.overrides.length) })
  return `  ${title}${version} · ${flags.join(' · ')} · ${rows}`
}

/** Official (installation-supplied) bundles first, then the profile's own. */
function bundleSectionLines(deps: PluginsInfoDeps, bundles: readonly BundleInfo[]): string[] {
  if (bundles.length === 0) return [t('plugins-bundles-empty')]
  const lines: string[] = [t('plugins-bundles-header')]
  const group = (label: string, group: readonly BundleInfo[]): void => {
    if (group.length === 0) return
    lines.push(` ${label}:`)
    for (const bundle of group) lines.push(bundleLine(deps, bundle))
  }
  group(t('plugins-bundles-official'), bundles.filter(bundle => bundle.optional))
  group(t('plugins-bundles-installed'), bundles.filter(bundle => !bundle.optional))
  // The tag is explained once per report, next to the rows it qualifies: this
  // surface is a transcript, so there is nothing to click open (C-3).
  if (bundles.some(bundle => !isCompositionOwned(bundle.name) && deps.declaration?.(bundle.name) === undefined)) {
    lines.push(t('plugins-tag-undeclared-hint'))
  }
  return lines
}

/** Loader entries the profile cannot address through a patch row. */
function pluginRowLines(plugins: readonly PluginInfo[]): string[] {
  const unaddressable = plugins.filter(plugin => !('patchId' in plugin))
  if (unaddressable.length === 0) return []
  return [
    t('plugins-rows-header'),
    ...unaddressable.map(plugin => {
      const reason = plugin.readOnlyReason === undefined ? '' : cell(plugin.readOnlyReason)
      return `  ${pluginRowTitle(plugin)} · ${reason} · ${cell(plugin.entryId)}`
    }),
  ]
}

/** Everything a listed installed bundle carries, in full. */
function installedBundleLines(deps: PluginsInfoDeps, bundle: BundleInfo): string[] {
  const lines = [t('plugins-info-bundle', { name: cell(bundle.name) }), bundleLine(deps, bundle)]
  if (bundle.rows.length > 0) {
    lines.push(t('plugins-info-rows-label'))
    for (const row of bundle.rows) {
      const entry = row.entryId === undefined ? '' : ` · ${cell(row.entryId)}`
      lines.push(`    ${cell(row.rowId)} → ${cell(row.moduleName)}${entry}`)
    }
  }
  if (bundle.overrides.length > 0) {
    lines.push(t('plugins-info-overrides-label', { list: cell(bundle.overrides.join(', ')) }))
  }
  if (bundle.error !== undefined) {
    const diagnostic = bundle.error.diagnostic === undefined ? '' : ` — ${cell(bundle.error.diagnostic)}`
    lines.push(t('plugins-info-problem', { code: cell(bundle.error.code), diagnostic }))
  }
  return lines
}

/** What an installation spec names, before anything installs it. */
function inspectionLines(spec: string, inspection: PluginSpecInspection): string[] {
  if (inspection.status === 'refused') {
    return [t('plugins-info-inspect-refused', { problem: cell(inspection.problem), reason: cell(inspection.reason) })]
  }
  const lines = [t('plugins-info-inspect-accepted', {
    name: cell(inspection.name ?? spec),
    version: cell(inspection.version ?? ''),
    kind: cell(inspection.kind),
    bundle: inspection.bundle === null ? '?' : String(inspection.bundle),
    registry: cell(inspection.registry ?? ''),
  })]
  if (inspection.description !== undefined) {
    lines.push(t('plugins-info-inspect-description', { description: cell(inspection.description) }))
  }
  if (inspection.host !== undefined) lines.push(t('plugins-info-inspect-host', { host: cell(inspection.host) }))
  return lines
}

/** `/plugin info <spec>`: the installed bundle when one matches, else inspect. */
async function infoLines(deps: PluginsInfoDeps, manager: PluginManagerView, spec: string): Promise<string[]> {
  const installed = (await manager.listBundles()).find(bundle => bundle.name === spec)
  if (installed !== undefined) return installedBundleLines(deps, installed)
  return inspectionLines(spec, await manager.inspect(spec))
}

/** `/plugin registries`: the registries an installation asks, in order. */
function registriesLines(registries: PluginRegistries): string[] {
  const none = t('plugins-info-registries-none')
  const asCell = (value: string | null): string => value === null ? none : cell(value)
  const fallbacks = registries.fallbackRegistries.length === 0
    ? none
    : cell(registries.fallbackRegistries.map(value => value ?? 'null').join(', '))
  return [
    t('plugins-info-registries-header'),
    t('plugins-info-registries-first', { registry: asCell(registries.registry) }),
    t('plugins-info-registries-fallbacks', { list: fallbacks }),
    t('plugins-info-registries-resolved', { registry: asCell(registries.resolved) }),
  ]
}

/** The service-backed half of the report (empty for a form that needs no service). */
export async function pluginServiceLines(
  args: string,
  deps: PluginsInfoDeps,
  manager: PluginManagerView | undefined,
): Promise<string[]> {
  const parsed = parsePluginArgs(args)
  if (parsed.kind === 'check' || parsed.kind === 'unknown') return []
  if (parsed.kind === 'info' && parsed.spec === '') return []
  if (manager === undefined) return [t('plugins-service-unavailable')]
  // The service belongs to the host: a refusal or a crash there must not take
  // the diagnostics half down with it. Every call funnels into one line, so a
  // rejected promise still leaves a readable report instead of an unhandled
  // rejection and an empty screen.
  try {
    if (parsed.kind === 'registries') return registriesLines(await manager.registries())
    if (parsed.kind === 'info') return await infoLines(deps, manager, parsed.spec)
    const bundles = await manager.listBundles()
    const plugins = await manager.listPlugins()
    return [...bundleSectionLines(deps, bundles), ...pluginRowLines(plugins)]
  } catch (error) {
    return [t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) })]
  }
}

/** `/plugin`: the diagnostics half plus the profile's own bundles and rows. */
export async function pluginReport(
  args: string,
  deps: PluginsInfoDeps,
  manager: PluginManagerView | undefined,
): Promise<string[]> {
  return [...pluginsInfoLines(args, deps), ...await pluginServiceLines(args, deps, manager)]
}
