import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { cleanRenderText } from '../channel/sanitize.js'
import type { GrantPlan, GrantPlanEntry } from '../dsh-adapter/grant-file.js'

/** Rows a confirmation pane shows before folding the rest into one line. */
const GRANT_LIST_MAX_ROWS = 12
/** Per-cell cap: a permission name and a scope are foreign text like any other. */
const GRANT_CELLS = 48
/** Both panes render this list inside `Pane`, which pads two cells on each side. */
const PANE_PADDING_CELLS = 4
/** What one row spends besides its two cells: `  `, ` @ ` and `  `. */
const ROW_SEPARATOR_CELLS = 7
/** Narrower cells than this stop being useful; the row may then lose its tail. */
const MIN_CELLS = 4
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
  // One row per permission. Besides the two foreign cells a row spends `  `,
  // ` @ `, the gap before the status and the localized status itself; `Pane`
  // adds two cells of padding on each side that `useTerminalSize()` does not
  // subtract. Measure the status instead of assuming it: the English labels are
  // wider than the Chinese ones. `wrap="truncate"` is the backstop for terminals
  // narrower than `MIN_CELLS`: an over-long row loses its tail instead of
  // growing a second line and pushing the key hint off the screen.
  const { columns } = useTerminalSize()
  // A reduce, not `Math.max(...map)`: the declaration is untrusted input and a
  // manifest can carry more permissions than the argument limit allows.
  const statusCells = plan.entries.reduce((widest, entry) => Math.max(widest, stringWidth(statusOf(entry))), 0)
  const cells = Math.max(MIN_CELLS, Math.min(GRANT_CELLS, Math.floor(
    (columns - PANE_PADDING_CELLS - ROW_SEPARATOR_CELLS - statusCells) / 2,
  )))
  const clean = (value: string): string => cleanRenderText(value, cells)
  const entries = [...plan.entries].sort(compareEntries)
  const shown = entries.slice(0, GRANT_LIST_MAX_ROWS)
  const hidden = entries.length - shown.length
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{t(mode === 'grant' ? 'plugins-grant-list-title' : 'plugins-grant-list-title-revoke')}</Text>
      {shown.map(entry => (
        <Text key={`${entry.name}\u0000${entry.scope}`} dimColor={entry.granted} wrap="truncate">
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
