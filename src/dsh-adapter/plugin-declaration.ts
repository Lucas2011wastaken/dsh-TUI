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
