import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { cleanRenderText } from '../channel/sanitize.js'
import type { GrantPlan, GrantPlanEntry } from '../dsh-adapter/grant-file.js'

/** Rows a confirmation pane shows before folding the rest into one line. */
const GRANT_LIST_MAX_ROWS = 12
/** Per-cell cap: a permission name and a scope are foreign text like any other. */
const GRANT_CELLS = 48
/** What one row spends on ` @ `, status and the pane's own padding. */
const ROW_OVERHEAD_CELLS = 32
/** The narrowest a name or scope is worth showing before the row stops being useful. */
const MIN_CELLS = 8
/** Unknown names named on the folded line before it becomes a list of its own. */
const UNKNOWN_NAMES_SHOWN = 3

/**
 * The permissions one lifecycle action is about, as the confirmation pane shows
 * them (grant lifecycle plan §8).
 *
 * Both the install confirmation and the lifecycle confirmation read the same
 * list, so they cannot describe the same declaration differently. Ordering is
 * deliberate: what is not granted yet comes first, and among those the
 * default-deny (the interception-class) permissions lead — the risk a person is
 * least likely to expect is what they see first. Already-granted entries sink
 * to the bottom, which also makes a hand-edited grant from an earlier run
 * visible before `Enter` is pressed.
 *
 * Presentational only; the state lives in the flows.
 */
export function PluginGrantList({ plan, mode }: { plan: GrantPlan; mode: 'grant' | 'revoke' }): React.ReactNode {
  // Nothing to show (a package that declares no permissions): the pane keeps its
  // own layout rather than printing an empty heading.
  if (plan.entries.length === 0 && plan.unknown.length === 0) return null
  // One row per permission: the status column is fixed text, and the two foreign
  // cells share what is left. At 50 columns each cell is ~8 cells, so the key
  // hint below the list stays on screen instead of being pushed out by wraps.
  const { columns } = useTerminalSize()
  const cells = Math.max(MIN_CELLS, Math.min(GRANT_CELLS, Math.floor((columns - ROW_OVERHEAD_CELLS) / 2)))
  const clean = (value: string): string => cleanRenderText(value, cells)
  const entries = [...plan.entries].sort(compareEntries)
  const shown = entries.slice(0, GRANT_LIST_MAX_ROWS)
  const hidden = entries.length - shown.length
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{t(mode === 'grant' ? 'plugins-grant-list-title' : 'plugins-grant-list-title-revoke')}</Text>
      {shown.map(entry => (
        <Text key={`${entry.name}\u0000${entry.scope}`} dimColor={entry.granted}>
          {`  ${clean(entry.name)} @ ${clean(entry.scope)}  ${statusOf(entry)}`}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>{`  ${t('plugins-grant-more', { count: String(hidden) })}`}</Text>}
      {plan.unknown.length > 0 && (
        <Text dimColor>
          {`  ${t('plugins-grant-unknown-line', {
            count: String(plan.unknown.length),
            names: `${plan.unknown.slice(0, UNKNOWN_NAMES_SHOWN).map(clean).join(', ')}${plan.unknown.length > UNKNOWN_NAMES_SHOWN ? '…' : ''}`,
          })}`}
        </Text>
      )}
    </Box>
  )
}

/** What one row says about itself: its registry default and whether it is granted. */
function statusOf(entry: GrantPlanEntry): string {
  const granted = t(entry.granted ? 'plugins-grant-granted' : 'plugins-grant-not-granted')
  const fallback = t(entry.default === 'allow' ? 'plugins-grant-default-allow' : 'plugins-grant-default-deny')
  return `${fallback}  ${granted}`
}

/** Not-yet-granted first, then default-deny before default-allow. */
function compareEntries(left: GrantPlanEntry, right: GrantPlanEntry): number {
  if (left.granted !== right.granted) return left.granted ? 1 : -1
  if (left.default !== right.default) return left.default === 'deny' ? -1 : 1
  return 0
}
