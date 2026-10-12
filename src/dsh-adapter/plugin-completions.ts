/**
 * `/plugin info <name>` completion: the bundles this profile added.
 *
 * The names come from the same host service and the same predicate the short
 * list reads (`extraBundles` in `./plugin-manager.ts`), so the popup and
 * `/plugin list` cannot disagree about what "added" means.
 *
 * The cache reads like `/model`'s (`channel/model-actions.ts`): one load, an
 * answer that arrives after the owner moved on is dropped, and the popup is
 * refreshed by `emit()` when the names land. A missing service — a non-DSH
 * kernel, an older host — answers an empty list: the tree then shows its static
 * subcommand nodes and nothing throws.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { CommandCompletionNode } from '../commands.js'
import { getLang } from '../i18n.js'
import { extraBundles, pluginManagerOf } from './plugin-manager.js'

/** What one listed package calls itself, in the reader's language. */
type LocalizedPluginText = string | { readonly en: string; readonly [locale: string]: string }

/**
 * Display title of one bundle. `meta` arrived after the 0.1.5 line, so an older
 * host answers the package name; the field is read structurally for the same
 * reason `plugins-info.ts` reads it that way.
 */
function bundleTitle(bundle: BundleInfo): string {
  const meta = (bundle as { readonly meta?: { readonly title?: LocalizedPluginText } }).meta
  const title = meta?.title
  if (title === undefined) return bundle.name
  if (typeof title === 'string') return title
  return title[getLang()] ?? title.en ?? bundle.name
}

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
    const live = (): boolean => deps.owner.current() && !deps.owner.signal.aborted
    load = manager.listBundles().then(bundles => {
      // A late answer after a release would write into a dead channel; let a
      // later warm try again instead of pinning the empty result.
      if (!live()) {
        load = undefined
        return
      }
      nodes = extraBundles(bundles).map(bundle => ({
        // The package name is what `/plugin info` matches, so it is the token;
        // the title and version are what a person recognizes in the popup.
        name: bundle.name,
        description: bundle.version === undefined ? bundleTitle(bundle) : `${bundleTitle(bundle)} · ${bundle.version}`,
        ...(bundle.enabled ? {} : { tag: 'off' }),
      }))
      deps.emit()
    }).catch(() => {
      load = undefined
      if (live()) nodes = []
    })
  }

  return { warmPluginNames, pluginNames: () => nodes ?? [] }
}
