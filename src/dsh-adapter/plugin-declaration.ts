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

/**
 * Whether a listed bundle belongs to the composition itself rather than to the
 * plugins a person installs. Gate 1 is a statement about *plugins* ("this
 * package declares no TUI contribution"), so applying it to the host's own
 * rows — or to this application — would report the composition as a missing
 * declaration. Everything else is judged by its declaration alone.
 */
export function isCompositionOwned(packageName: string): boolean {
  return packageName.startsWith('@deepseek-ai/') || packageName === '@deepseek-harness-tui/dsh-tui'
}
