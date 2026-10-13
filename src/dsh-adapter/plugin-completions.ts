/**
 * `/plugin info <name>` completion: the bundles this profile added.
 *
 * The names come from the same host service and the same predicate the short
 * list reads (`extraBundles` in `./plugin-manager.ts`), so the popup and
 * `/plugin list` cannot disagree about what "added" means.
 *
 * The cache reads like `/model`'s (`channel/model-actions.ts`): one load, an
 * answer that arrives after the owner moved on is dropped, and the popup is
 * refreshed by `emit()` when the names land. A service that is missing — a
 * non-DSH kernel, an older host — or that throws before it returns a promise
 * answers the same empty list: the tree then shows its static subcommand nodes
 * and nothing throws.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { CommandCompletionNode } from '../commands.js'
import { extraBundles, localizedPluginText, pluginManagerOf } from './plugin-manager.js'

/** The warm-and-read pair the slash completion tree consumes. */
export function createPluginCompletionCatalog(ctx: Context, deps: {
  owner: { readonly signal: AbortSignal; current(): boolean }
  emit(): void
}): {
  warmPluginNames(): void
  pluginNames(): readonly CommandCompletionNode[]
} {
  let nodes: readonly CommandCompletionNode[] | undefined
  let load: Promise<void> | undefined

  const warmPluginNames = (): void => {
    if (load !== undefined) return
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) {
      nodes = []
      return
    }
    let pending: Promise<BundleInfo[]>
    try {
      pending = manager.listBundles()
    } catch {
      // The service threw before it returned a promise; `.catch` only covers a
      // rejection, so the raw throw would otherwise reach the keystroke path
      // that asked for the names. Answer an empty list like an absent service,
      // and leave `load` unset so a later warm can try again.
      nodes = []
      return
    }
    const live = (): boolean => deps.owner.current() && !deps.owner.signal.aborted
    load = pending.then(bundles => {
      // A late answer after a release would write into a dead channel; let a
      // later warm try again instead of pinning the empty result.
      if (!live()) {
        load = undefined
        return
      }
      nodes = extraBundles(bundles).map(bundle => {
        // The package name is what `/plugin info` matches, so it is the token;
        // the title and version are what a person recognizes in the popup. The
        // title comes from the report's own reader, so the two never disagree.
        const title = localizedPluginText(bundle, bundle.name)
        return {
          name: bundle.name,
          description: bundle.version === undefined ? title : `${title} · ${bundle.version}`,
          ...(bundle.enabled ? {} : { tag: 'off' }),
        }
      })
      deps.emit()
    }).catch(() => {
      load = undefined
      if (live()) nodes = []
    })
  }

  return { warmPluginNames, pluginNames: () => nodes ?? [] }
}
