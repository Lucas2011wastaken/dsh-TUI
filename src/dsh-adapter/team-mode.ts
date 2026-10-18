/**
 * Agent Teams status at run time (issue #1241, see
 * docs/agent-teams-design.md「开关机制」).
 *
 * Switching is the upstream team bundle itself: `/plugin enable|disable`
 * selects or drops its layer through the host plugin manager, which persists
 * to the profile and, with `hmr` mounted, applies at once. `/team` is the
 * read-only side: it reports the bundle, the service and this session's
 * teammates, and is exposed only while the `agentTeams` service is mounted —
 * the same availability the desktop UI gives the feature. A typed `/team`
 * before that still answers with the enable route instead of reaching the
 * model.
 *
 * What stays here besides the command is the one decision that cannot live in
 * a preset — which legacy delegation tools a request carries.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { LocalCommand } from '../commands.js'
import { t } from '../i18n.js'
import type { TeamActiveMembers } from './plugin-manage.js'
import { pluginManagerOf } from './plugin-manager.js'
import { cell } from './plugins-info.js'
import { TEAM_BUNDLE } from './team-roster.js'
import { TEAM_SPAWN_TOOL } from './team-tools.js'

/** The slash-command name this module owns. */
const TEAM_COMMAND_NAME = 'team'

/**
 * Whether the team service is mounted. This is the one signal `/team` appears
 * on: the desktop UI shows the same feature only while its service is there.
 * @param ctx - Host context of the composition root.
 */
export function teamServiceActive(ctx: Context): boolean {
  return ctx.get('agentTeams', false) !== undefined
}

/**
 * Hide `/team` from Help and `/` completion while the service is not mounted.
 * The typed form stays a local command (`isLocalCommandName` still knows the
 * name), so it can answer with the enable route instead of becoming text sent
 * to the model.
 * @param commands - The current command catalog.
 * @param visible - Whether the team service is mounted.
 * @returns The catalog with `/team` removed when it is not.
 */
export function withTeamCommandVisibility(commands: readonly LocalCommand[], visible: boolean): readonly LocalCommand[] {
  return visible ? commands : commands.filter(command => command.name !== TEAM_COMMAND_NAME)
}

/**
 * Legacy delegation tools that `spawn_teammate` replaces. The four control
 * tools the team shares names with (`send_message`, `list_agents`,
 * `interrupt_agent`, `wait_agent`) need no entry: the team copies live in the
 * Agent's own scope and shadow the preset's, in the assembly and at execution.
 */
const TEAM_REPLACED_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

/**
 * Keep one delegation tool set per request. Presets keep their legacy rows,
 * so whether the team replaces them is decided where the tools are known: an
 * assembly carrying `spawn_teammate` drops `subagent` / `subagent_fork`. This
 * follows a bundle toggled at run time into the sessions already joined (a
 * preset revision cannot), and a team service that never activated leaves the
 * legacy tools in place. The agent loop diffs these final tools against the
 * logged request header, so the model is told about each swap.
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @returns The original assembly, or a copy without the replaced tools.
 */
export function filterTeamReplacedTools(assembly: PromptAssembly): PromptAssembly {
  if (!assembly.tools.some(tool => tool.name === TEAM_SPAWN_TOOL)) return assembly
  if (!assembly.tools.some(tool => TEAM_REPLACED_TOOLS.has(tool.name))) return assembly
  return { ...assembly, tools: assembly.tools.filter(tool => !TEAM_REPLACED_TOOLS.has(tool.name)) }
}

/** What `/team` was asked. */
export type TeamCommand =
  | { readonly kind: 'status' }
  /** `on` / `off`: the switch moved to `/plugin enable|disable`. */
  | { readonly kind: 'switch' }
  | { readonly kind: 'unknown'; readonly sub: string }

export function parseTeamArgs(args: string): TeamCommand {
  const sub = args.trim().split(/\s+/)[0] ?? ''
  if (sub === '' || sub === 'status') return { kind: 'status' }
  if (sub === 'on' || sub === 'off') return { kind: 'switch' }
  return { kind: 'unknown', sub }
}

/** What the screen supplies: the bound session's live team counts. */
export interface TeamCommandSink {
  /** Teammates of the bound session, how many are running or provisioning, and how many may be running. */
  readonly members: () => { readonly total: number } & TeamActiveMembers
}

/** The entry the screen calls: argument text in, report lines out. */
export type TeamCommandEntry = (args: string, sink: TeamCommandSink) => Promise<readonly string[]>

/**
 * Wire `/team` to the running composition. The command only reports; the
 * bundle switch is `/plugin enable|disable`, which shares the lifecycle flow
 * and its confirmations.
 * @param ctx - Host context of the composition root.
 * @returns the command entry the screen calls.
 */
export function createTeamCommandEntry(ctx: Context): TeamCommandEntry {
  return (args, sink) => {
    const parsed = parseTeamArgs(args)
    if (parsed.kind === 'switch') {
      return Promise.resolve([t('team-cmd-switch-moved', { bundle: TEAM_BUNDLE })])
    }
    if (parsed.kind === 'unknown') {
      return Promise.resolve([t('team-cmd-usage', { sub: cell(parsed.sub) })])
    }
    // The command is hidden from the catalog in this state, but a typed one is
    // still a local command: answer where the switch is instead of failing.
    if (!teamServiceActive(ctx)) {
      return Promise.resolve([t('team-cmd-not-enabled', { bundle: TEAM_BUNDLE })])
    }
    return teamStatusLines(ctx, sink)
  }
}

/**
 * `/team` and `/team status`: whether the profile selects the bundle, whether
 * the team service is running in this process, and the bound session's team.
 */
async function teamStatusLines(ctx: Context, sink: TeamCommandSink): Promise<readonly string[]> {
  const manager = pluginManagerOf(ctx)
  const service = teamServiceActive(ctx)
  const lines: string[] = []
  if (manager === undefined) {
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    lines.push(t('team-cmd-no-manager'))
  } else {
    let selected: boolean | undefined
    try {
      const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
      selected = bundle?.enabled
      lines.push(selected === undefined
        ? t('team-cmd-bundle-unknown')
        : t('team-cmd-bundle', { state: t(selected ? 'team-cmd-on' : 'team-cmd-off') }))
    } catch (error) {
      lines.push(t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) }))
    }
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    // The profile says on but nothing runs (a startup-only profile, or the
    // service failed to activate), or the reverse: say which one wins now.
    if (selected === true && !service) lines.push(t('team-cmd-pending-on'))
    if (selected === false && service) lines.push(t('team-cmd-pending-off'))
  }
  const { total, active, unseen } = sink.members()
  lines.push(total === 0
    ? t('team-cmd-no-members')
    : t(unseen === 0 ? 'team-cmd-members' : 'team-cmd-members-unseen', { total: String(total), active: String(active), unseen: String(unseen) }))
  return lines
}
