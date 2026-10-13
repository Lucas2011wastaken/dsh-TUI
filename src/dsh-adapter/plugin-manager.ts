/**
 * The host's profile plugin manager (`ctx.pluginManager`), as this package
 * consumes it.
 *
 * The service is host-provided: the dsh CLI ships
 * `@deepseek-ai/dsh-plugin-manager` and the `plugin-manager` row dsh-base
 * patches in mounts it for `dsh --profile` boots. A profile has no copy of the
 * package, so the service is optional here — every consumer soft-probes it and
 * degrades to a readable diagnostic instead of failing (issue #183: consumers
 * never take it through `inject`).
 *
 * {@link PluginManagerView} is the surface this package uses, declared
 * structurally so a regression can hand in a fake. The record types come from
 * the host package's own published declarations, so a field rename on the
 * upstream line fails the build rather than the screen.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  BundleInfo,
  InspectOptions,
  PluginInfo,
  PluginRegistries,
  PluginSpecInspection,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { getLang, type Lang } from '../i18n.js'
import { isCompositionOwned } from './plugin-declaration.js'

/** The host service operations this package consumes. */
export interface PluginManagerView {
  /** Every installed or installation-provided bundle, in profile layer order. */
  listBundles(): Promise<BundleInfo[]>
  /** Every running-profile loader entry and its persistent control availability. */
  listPlugins(): Promise<PluginInfo[]>
  /** The registries an installation asks, in order. */
  registries(): Promise<PluginRegistries>
  /** What a spec names, read before installing it. */
  inspect(spec: string, options?: InspectOptions): Promise<PluginSpecInspection>
}

/**
 * Soft-probe the profile plugin manager. `undefined` when the row is not
 * mounted (a non-DSH kernel composition, an older host, a bare Cordis root):
 * the caller reports what it cannot do instead of throwing.
 */
export function pluginManagerOf(ctx: Context): PluginManagerView | undefined {
  const manager = ctx.get('pluginManager', false)
  if (manager === undefined || manager === null) return undefined
  return manager as PluginManagerView
}

/**
 * The bundles a person added to this profile: the ones its own dependencies
 * hold (`installed`), minus the composition itself. The installation-supplied
 * bundles and this application's own rows are not plugins anybody installed,
 * so the short list leaves them out — a clean profile reports "nothing added"
 * instead of listing the launcher's base. One predicate, so the list and the
 * `/plugin info` completion cannot drift apart.
 */
export function extraBundles(bundles: readonly BundleInfo[]): BundleInfo[] {
  return bundles.filter(bundle => bundle.installed && !isCompositionOwned(bundle.name))
}

/** The host's localized display text: a literal, or translations by language id. */
export type LocalizedPluginText = string | { readonly en: string; readonly [locale: string]: string }

/**
 * What a bundle or loader entry calls itself, in the reader's language. The
 * entry stays `unknown` on purpose: `meta` arrived after the 0.1.5 line, so the
 * alpha.2 compat line's own declarations may not carry the field at all
 * (`verify:alpha-source` type-checks this package against them), and reading it
 * structurally is what keeps one reader compiling on every line. An older host
 * that answers without it takes the caller's fallback — the package name, the
 * module specifier — and one reader means the report's rows and the completion
 * popup cannot disagree about a title.
 */
export function localizedPluginText(entry: unknown, fallback: string): string {
  return pluginTitleIn(entry, getLang(), fallback)
}

/**
 * {@link localizedPluginText} pinned to one named language — the completion
 * catalog caches every shipped language at once, so it cannot ask the active
 * one and then serve a stale answer after `/lang`.
 */
export function pluginTitleIn(entry: unknown, lang: Lang, fallback: string): string {
  const meta = (entry as { readonly meta?: { readonly title?: LocalizedPluginText } } | undefined)?.meta
  const title = meta?.title
  if (title === undefined) return fallback
  if (typeof title === 'string') return title
  return title[lang] ?? title.en ?? fallback
}
