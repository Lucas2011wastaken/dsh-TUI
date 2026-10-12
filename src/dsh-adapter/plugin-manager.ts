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
