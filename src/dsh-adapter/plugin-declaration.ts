/**
 * Where a plugin package states what it contributes (gate 1's evidence).
 *
 * A plugin declares itself by shipping a package-root `dsh-plugin.json` — the
 * pinned `@dsh-std/manifest` shape this profile's admission catalog validates
 * (`docs/plugin-admission-and-development.md`). That is the same artifact the
 * plugin-host admits third-party activations from (`./admission-loader.ts`),
 * so the list and the admission path read one declaration, not two.
 *
 * Resolution follows `./bundled-presets.ts`: bare package names resolve from
 * the composition's `baseUrl` (the profile directory a `dsh --profile` boot
 * sets), so this reads the profile's own install tree and never scans
 * node_modules. The package.json hop goes through `findPackageJSON`, which
 * still finds the package when its `exports` map hides the extra file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BACKEND, validateBackendSpec, type BackendSpec } from '../adapter/spec/tui-contributions.js'

/** One package's declaration: the file it lives in and its exact bytes. */
export interface PluginDeclaration {
  readonly path: string
  readonly source: string
}

/**
 * The package-root `dsh-plugin.json` of `packageName`, or `undefined` when the
 * package is not resolvable from this composition or ships no declaration.
 * Tolerant by design: a broken install answers "no declaration", never a throw.
 */
export function pluginDeclarationOf(ctx: Context, packageName: string): PluginDeclaration | undefined {
  let manifestPath: string | undefined
  try {
    manifestPath = findPackageJSON(packageName, (ctx as { baseUrl?: string }).baseUrl ?? import.meta.url)
  } catch {
    return undefined
  }
  if (manifestPath === undefined) return undefined
  const file = join(dirname(manifestPath), 'dsh-plugin.json')
  if (!existsSync(file)) return undefined
  try {
    return { path: file, source: readFileSync(file, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * One `Backend` contribution a package declaration carries, as this host's own
 * `Backend` definition reads it (D-1).
 */
export interface DeclaredBackend {
  /** The declaration's own `name` (the contribution's local name, distinct from
   *  the backend id its `spec` carries). */
  readonly name: string
  /** The public declaration, already validated: `validateBackendSpec()`'s result. */
  readonly spec: BackendSpec
}

/** What one declaration contributes, and what could not be read out of it. */
export interface DeclaredBackends {
  readonly backends: readonly DeclaredBackend[]
  /** Entries that announced themselves as `Backend` contributions but are not
   *  one this host can read; each names the entry and why. Empty is the normal
   *  answer for a package that contributes no backend. */
  readonly problems: readonly string[]
}

const NO_BACKENDS: DeclaredBackends = Object.freeze({ backends: Object.freeze([]), problems: Object.freeze([]) })

/**
 * The `Backend` contributions of one `dsh-plugin.json` record.
 *
 * One reader for every consumer — the C-5 residue watch (`plugin-manage.ts`) and
 * the D-1 assembly both ask this — so the two cannot disagree about which entries
 * are backend contributions. It applies the same three gates the admission path
 * applies, in the same order: the definition's own coordinate (`apiVersion` +
 * `kind`), the definition's metadata rule (`name`), then the family validator. An
 * entry that fails any of them is reported in `problems` rather than dropped in
 * silence; a `null`/non-object record simply contributes nothing.
 *
 * Identity is deliberately not this function's business: it reads a record the
 * caller already obtained, and says nothing about which package that record
 * belongs to (#1568 — a manifest counts only beside the package root that
 * establishes it).
 */
export function declaredBackendsOf(record: unknown): DeclaredBackends {
  if (record === null || typeof record !== 'object') return NO_BACKENDS
  const contributes = (record as Record<string, unknown>).contributes
  if (contributes === null || typeof contributes !== 'object') return NO_BACKENDS
  const entries = (contributes as Record<string, unknown>)['x-dsh-tui']
  if (!Array.isArray(entries)) return NO_BACKENDS
  const backends: DeclaredBackend[] = []
  const problems: string[] = []
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    if (candidate.kind !== BACKEND.kind) continue
    const where = `contributes['x-dsh-tui'][${index}]`
    if (candidate.apiVersion !== BACKEND.apiVersion) {
      problems.push(`${where} is a ${BACKEND.kind} of ${String(candidate.apiVersion)}, not ${BACKEND.apiVersion}`)
      continue
    }
    const name = candidate.name
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(name)) {
      problems.push(`${where}.name is missing or invalid`)
      continue
    }
    try {
      backends.push({ name, spec: validateBackendSpec(candidate.spec) })
    } catch (error) {
      problems.push(`${where} (${name}) has an invalid Backend content: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { backends, problems }
}

/**
 * {@link declaredBackendsOf} over a declaration's raw bytes. A declaration that
 * does not parse is a problem, not an empty answer: the file is there and says
 * something this host cannot read.
 */
export function declaredBackendsIn(source: string): DeclaredBackends {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { backends: [], problems: [`the declaration is not valid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  return declaredBackendsOf(parsed)
}

/** This application's own package: the composition, never a plugin of it. */
export const COMPOSITION_PACKAGE = '@deepseek-harness-tui/dsh-tui'

/**
 * What a listed bundle belongs to the composition itself rather than to the
 * plugins a person installs. Gate 1 is a statement about *plugins* ("this
 * package declares no TUI contribution"), so applying it to the host's own
 * rows — or to this application — would report the composition as a missing
 * declaration. Everything else is judged by its declaration alone.
 */
export function isCompositionOwned(packageName: string): boolean {
  return packageName.startsWith('@deepseek-ai/') || packageName === COMPOSITION_PACKAGE
}

/**
 * The package-root declaration of a directory that is not installed yet: a
 * `/plugin install <path>` spec names its directory, so the pre-install notice
 * can read the same file the admission path will read after the install.
 * Tolerant like {@link pluginDeclarationOf}: a missing or unreadable file
 * answers "no declaration", never a throw. A spec that names a tarball, a git
 * URL or a registry package has no directory here — the caller reports the
 * notice as unjudged rather than guessing.
 */
export function pluginDeclarationIn(directory: string): PluginDeclaration | undefined {
  const file = join(directory, 'dsh-plugin.json')
  if (!existsSync(file)) return undefined
  try {
    return { path: file, source: readFileSync(file, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * Gate 1's pre-install statement about a package, as data (Stage C-4).
 *
 * `unjudged` is the honest answer for anything whose declaration is not on
 * this machine yet — a registry spec has no package-root file to read before
 * the install runs. The notice therefore never claims "this package supports
 * dsh-tui"; it says either what it read, or that the answer arrives with the
 * install (the standing tag in `/plugin` is what really reports it, C-3).
 */
export type PluginInstallNotice =
  /** A declaration was read and this profile accepts it. */
  | { readonly kind: 'declared' }
  /** Read, and the package ships no package-root `dsh-plugin.json`. */
  | { readonly kind: 'undeclared' }
  /**
   * Read, and this profile cannot accept it: it does not parse, does not
   * project, or fails the admission catalog's validation. The five-state
   * negotiation is deliberately not part of this answer — it is a statement
   * about a *running* host, and the standing tag in `/plugin` reports it after
   * the install.
   */
  | { readonly kind: 'invalid'; readonly error: string }
  /** Nothing on disk to read yet: the answer arrives with the install. */
  | { readonly kind: 'unjudged' }
