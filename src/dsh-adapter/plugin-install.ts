/**
 * `/plugin install <spec>`: the write half of the plugin command (Stage C-4).
 *
 * The flow owns the whole conversation with the host service — what a spec
 * names, gate 1's pre-install notice, gate 3's trust routing, pnpm's progress,
 * cancellation, the build-script approval, the version-exemption escape and
 * the final report — and it produces the transcript lines for all of it.
 *
 * What it does not do is ask. Every point where a person decides comes back as
 * a {@link PluginInstallStep}; the UI renders it and answers by calling the
 * next method. That keeps key handling where every other overlay keeps it
 * (`Chat.tsx`) and the domain here, and it lets a regression drive the whole
 * flow through a fake service without a terminal.
 *
 * Three rules the service's own semantics force:
 *
 * - `installBundle` resolves only once the run is over and the profile was
 *   restored or changed, so the promise IS the result. The service deletes a
 *   request the moment it settles, which makes `waitForInstall` a recovery path
 *   for a caller that lost the promise — not a mailbox to collect from, and not
 *   something this flow needs (it never lets go).
 * - A failure arrives in-band: the service folds every error into
 *   `application: 'failed'` with `result.error`. Only a lock or disposal error
 *   rejects, so the flow contains both shapes.
 * - Everything asynchronous is fenced to the binding that asked. A `/new` or a
 *   resume mid-install must not write pnpm output into the new session's
 *   transcript; the run itself is a profile-level operation and keeps going.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult,
  IncompatiblePlugin,
  InstallBundleOptions,
  InstallSpecKind,
  PluginInstallRequestId,
  PluginSpecInspection,
  Registry,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from '../i18n.js'
import { installedTuiVersion, resolveDshProfileName } from '../update.js'
import { COMPOSITION_PACKAGE, pluginDeclarationOf, type PluginInstallNotice } from './plugin-declaration.js'
import { type FirstPartyFeedLoad, firstPartyVerdict, type FirstPartyVerdict, loadFirstPartyFeed } from './plugin-feed.js'
import { newInstallRequestId, pluginInstallEvents, pluginManagerOf, type PluginInstallEvents, type PluginManagerView } from './plugin-manager.js'
import { cell, declarationNoticeFor, parsePluginArgs } from './plugins-info.js'

/** How many lines of pnpm's output the failure report keeps. */
export const INSTALL_LOG_TAIL = 6

/** What a spec names, once the service has read it. */
export interface PluginArtifact {
  readonly name?: string | undefined
  readonly version?: string | undefined
  readonly kind: InstallSpecKind
  readonly bundle: boolean | null
  readonly registry: Registry
  readonly host?: string | undefined
}

/** What the profile's compatibility file currently exempts. */
export type VersionExemptions = ReturnType<PluginManagerView['listVersionExemptions']>

/**
 * What `/plugin install` has to say next. `done` means the flow has reported
 * everything it is going to report: refused, finished, failed or cancelled.
 */
export type PluginInstallStep =
  | {
    readonly kind: 'confirm'
    readonly artifact: PluginArtifact
    /** Gate 3: whether the feed vouches for this exact artifact. */
    readonly trust: FirstPartyVerdict
    /** Gate 1: what could be read about the package's declarations, before it lands. */
    readonly notice: PluginInstallNotice
  }
  /** pnpm was blocked by build scripts this profile has not approved. */
  | { readonly kind: 'build-blocked'; readonly builds: readonly string[] }
  /** The running host refuses this exact version; the exemption is the escape. */
  | { readonly kind: 'incompatible'; readonly packages: readonly IncompatiblePlugin[]; readonly exemptions: VersionExemptions }
  | { readonly kind: 'done' }

/** What the caller of a flow supplies that only the UI knows. */
export interface PluginInstallSink {
  /** The session the flow's output belongs to; see `binding` below. */
  readonly binding: () => number
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
}

export interface PluginInstallFlowOptions {
  readonly manager: PluginManagerView
  readonly spec: string
  /** The feed the trust verdict reads (loaded once by the caller). */
  readonly feed: FirstPartyFeedLoad
  /** Gate 1's evidence for one target; `declarationNoticeFor` in the wiring. */
  readonly noticeOf: (target: { readonly name?: string | undefined; readonly directory?: string | undefined }) => PluginInstallNotice
  /** Resolve a path spec to a directory, when the caller knows the profile root. */
  readonly specDirectory?: ((spec: string) => string | undefined) | undefined
  /** The binding generation that asked; every asynchronous write is fenced to it. */
  readonly binding: () => number
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
  /** The manager's install events, when the caller has a context to subscribe on. */
  readonly events?: PluginInstallEvents | undefined
  /** This package's running version — the other side of the drift check. */
  readonly ownVersion?: string | undefined
  /** The profile an installation belongs to, for the manual commands. */
  readonly profileName?: string | undefined
  /** The registry asked first. */
  readonly registry?: Registry | undefined
  /** Injectable for a regression; a fresh process-unique id otherwise. */
  readonly requestId?: PluginInstallRequestId | undefined
}

export interface PluginInstallFlow {
  readonly requestId: PluginInstallRequestId
  /** Read the spec, judge it, and either ask (gate 1 / gate 3) or install straight away. */
  begin(): Promise<PluginInstallStep>
  /** Answer a `confirm` step: proceed. */
  confirm(): Promise<PluginInstallStep>
  /** Answer a `build-blocked` step: allow these scripts and retry. */
  approve(builds: readonly string[]): Promise<PluginInstallStep>
  /** Answer an `incompatible` step: exempt these exact versions and retry. */
  acceptRisk(): Promise<PluginInstallStep>
  /** Stop the run and wait until the profile is back. */
  cancel(): Promise<PluginInstallStep>
  /** Release the event subscriptions. */
  dispose(): void
}

/** The reason line for a result that failed, from the most specific field it carries. */
function failureReasonOf(result: ChangeResult): string {
  const error = result.error
  if (error !== undefined) {
    return error.diagnostic === undefined ? error.code : `${error.code} — ${cell(error.diagnostic)}`
  }
  if (result.packageResult?.kind !== undefined) return result.packageResult.kind
  if (result.failedAt !== undefined) return result.failedAt
  return 'unknown'
}

export function createPluginInstallFlow(options: PluginInstallFlowOptions): PluginInstallFlow {
  const requestId = options.requestId ?? newInstallRequestId()
  const bindingAtStart = options.binding()
  /** The artifact `inspect()` read; a retry installs the same one. */
  let artifact: PluginArtifact | undefined
  /** Build scripts approved for this run, carried across a retry. */
  let approvedBuilds: readonly string[] | undefined
  /** What the last incompatible failure named, for `acceptRisk()`. */
  let incompatible: readonly IncompatiblePlugin[] = []
  /** The lines of pnpm output kept for a failure report. */
  const logTail: string[] = []
  let stopped = false
  /** Whether `installBundle` was actually called: before that there is nothing to cancel. */
  let installStarted = false
  const disposers: Array<() => void> = []

  /** Whether the session that asked is still bound; false drops every write. */
  const live = (): boolean => options.binding() === bindingAtStart
  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0 || !live()) return
    options.onLines(lines)
  }
  const tailLines = (): string[] => logTail.map(line => `  ${line}`)

  if (options.events !== undefined) {
    disposers.push(options.events.onState(requestId, progress => {
      if (progress.phase === 'installing' && progress.attempt !== undefined) {
        emit([t('plugins-install-attempt', {
          index: String(progress.attempt.index),
          total: String(progress.attempt.total),
          registry: cell(progress.attempt.registry ?? ''),
        })])
        return
      }
      emit([t(progress.phase === 'cancelling'
        ? 'plugins-install-cancelling'
        : progress.phase === 'applying' ? 'plugins-install-applying' : 'plugins-install-installing')])
    }))
    // Raw pnpm output is noise on a working install and the only evidence on a
    // failed one: keep the last lines and report them with the failure.
    disposers.push(options.events.onLog(requestId, chunk => {
      for (const line of chunk.text.split(/\r?\n/u)) {
        const text = cell(line)
        if (text.trim() === '') continue
        logTail.push(text)
      }
      while (logTail.length > INSTALL_LOG_TAIL) logTail.shift()
    }))
  }

  /** Read the spec; report and answer `undefined` when it is not installable. */
  async function inspect(): Promise<PluginArtifact | undefined> {
    let inspection: PluginSpecInspection
    try {
      inspection = await options.manager.inspect(
        options.spec,
        options.registry === undefined ? undefined : { registry: options.registry },
      )
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return undefined
    }
    if (inspection.status === 'refused') {
      emit([t('plugins-info-inspect-refused', { problem: inspection.problem, reason: cell(inspection.reason) })])
      return undefined
    }
    const read: PluginArtifact = {
      name: inspection.name,
      version: inspection.version,
      kind: inspection.kind,
      bundle: inspection.bundle,
      registry: inspection.registry,
      host: inspection.host,
    }
    artifact = read
    emit([t('plugins-install-inspect', {
      spec: cell(inspection.name === undefined
        ? options.spec
        : `${inspection.name}${inspection.version === undefined ? '' : `@${inspection.version}`}`),
      kind: read.kind,
      bundle: read.bundle === true ? 'bundle' : read.bundle === false ? 'not a bundle' : 'unknown',
    })])
    return read
  }

  /** Gate 3's routing and gate 1's notice: ask, or go on when nothing is askable. */
  function route(read: PluginArtifact): PluginInstallStep {
    // The kind is part of the question: only a registry artifact can be the
    // published one the feed lists (a directory or git checkout is read from
    // the manifest it ships, so it would vouch for itself).
    const trust = firstPartyVerdict(options.feed, { name: read.name, version: read.version, kind: read.kind })
    if (trust.kind === 'first-party') {
      emit([t('plugins-install-trusted', { name: cell(trust.entry.name), version: cell(trust.entry.version) })])
    }
    const notice = options.noticeOf({
      name: read.name,
      directory: options.specDirectory?.(options.spec),
    })
    // Gate 1 is a notice, never a veto: it is shown whenever it has something to
    // say. A first-party package with a readable, accepted declaration is the one
    // case with nothing to ask about — that is what skipping the trust
    // confirmation means. It does not skip the ledger or the list.
    if (trust.kind === 'first-party' && notice.kind === 'declared') return { kind: 'done' }
    return { kind: 'confirm', artifact: read, trust, notice }
  }

  /**
   * The profile's current exemptions. `listVersionExemptions()` is the one
   * service call that answers synchronously, so it is also the one that can
   * throw past a `catch` on a promise: read it defensively and say so, because
   * the pane shows what it returns.
   */
  function exemptionsNow(): VersionExemptions {
    try {
      return options.manager.listVersionExemptions()
    } catch (error) {
      emit([t('plugins-install-exemptions-unreadable', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { exemptions: {}, warnings: [] }
    }
  }

  /** Install, then turn the service's own result into the next step. */
  async function run(): Promise<PluginInstallStep> {
    const read = artifact
    // A person who closed the pane while the spec was still being read has not
    // asked for this install: the inspection's answer must not start one.
    if (read === undefined || stopped) return { kind: 'done' }
    let result: ChangeResult
    try {
      const installOptions: InstallBundleOptions = {
        requestId,
        ...options.registry === undefined ? {} : { registry: options.registry },
        ...approvedBuilds === undefined ? {} : { approvedBuilds: [...approvedBuilds] },
      }
      installStarted = true
      result = await options.manager.installBundle(options.spec, installOptions)
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    }
    // The cancel path reports itself; an install that ends `cancelled` after it
    // must not report a second, contradictory ending.
    if (result.application === 'cancelled') return { kind: 'done' }
    const builds = result.pendingBuilds ?? []
    if (builds.length > 0) {
      emit([t('plugins-install-build-blocked', { count: String(builds.length) })])
      return { kind: 'build-blocked', builds }
    }
    if (result.application === 'failed') {
      incompatible = result.error?.code === 'incompatible-version' ? result.error.incompatible ?? [] : []
      if (incompatible.length > 0) {
        emit([t('plugins-install-incompatible', {
          packages: incompatible.map(entry => `${cell(entry.name)}@${cell(entry.version)}`).join(', '),
          runtime: cell(incompatible[0]?.runtimeVersion ?? ''),
        })])
        return { kind: 'incompatible', packages: incompatible, exemptions: exemptionsNow() }
      }
      const output = result.packageResult?.output
      if (output !== undefined) {
        for (const line of output.split(/\r?\n/u).slice(-INSTALL_LOG_TAIL)) {
          const text = cell(line)
          if (text.trim() !== '') logTail.push(text)
        }
        while (logTail.length > INSTALL_LOG_TAIL) logTail.shift()
      }
      emit([
        t('plugins-install-failed', { reason: failureReasonOf(result) }),
        ...tailLines(),
        t('plugins-install-manual', { profile: cell(options.profileName ?? 'dsh-tui'), spec: cell(options.spec) }),
        t('plugins-install-rescue'),
      ])
      return { kind: 'done' }
    }
    const bundle = result.bundle ?? read.name ?? options.spec
    const stateKey = result.application === 'restart-required'
      ? 'plugins-install-state-restart'
      : result.application === 'overridden' ? 'plugins-install-state-overridden' : 'plugins-install-state-applied'
    emit([
      t('plugins-install-done', { bundle: cell(bundle), state: t(stateKey) }),
      ...result.application === 'restart-required' ? [t('plugins-install-restart-hint')] : [],
    ])
    await reportDrift()
    return { kind: 'done' }
  }

  /**
   * The #1340 drift check: installing a plugin must not move this application's
   * own version behind its back. Detected and reported, never repaired — the fix
   * is a command a person runs.
   */
  async function reportDrift(): Promise<void> {
    const running = options.ownVersion
    if (running === undefined) return
    let bundles
    try {
      bundles = await options.manager.listBundles()
    } catch {
      return
    }
    const own = bundles.find(bundle => bundle.name === COMPOSITION_PACKAGE)
    if (own?.version === undefined || own.version === running) return
    emit([t('plugins-install-drift', {
      name: COMPOSITION_PACKAGE,
      found: cell(own.version),
      running: cell(running),
      profile: cell(options.profileName ?? 'dsh-tui'),
    })])
  }

  /** Grant the exact-version exemptions the last failure named, then retry. */
  async function riskAndRetry(): Promise<PluginInstallStep> {
    if (incompatible.length === 0 || stopped) return { kind: 'done' }
    const packages = [...incompatible]
    try {
      for (const entry of packages) {
        // A refusal is in-band (`application: 'failed'`): a stale runtime
        // version, an unrepairable compatibility file, a missing --accept-risk.
        // Reporting it as granted and retrying would send the person in a loop
        // that cannot succeed.
        const outcome = await options.manager.setVersionExemption(`${entry.name}@${entry.version}`, entry.runtimeVersion, true, true)
        if (outcome.application === 'failed') {
          emit([t('plugins-install-failed', { reason: failureReasonOf(outcome) })])
          return { kind: 'done' }
        }
      }
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    }
    emit([t('plugins-install-exempted', { count: String(packages.length) })])
    incompatible = []
    return run()
  }

  return {
    requestId,
    async begin() {
      const read = await inspect()
      if (read === undefined) return { kind: 'done' }
      // The read can take a moment (a registry round trip): a cancel that lands
      // while it is in flight stops the flow here, before anything is asked or
      // installed.
      if (stopped) return { kind: 'done' }
      const step = route(read)
      return step.kind === 'confirm' ? step : run()
    },
    async confirm() {
      return stopped ? { kind: 'done' } : run()
    },
    async approve(builds) {
      if (stopped) return { kind: 'done' }
      approvedBuilds = builds
      emit([t('plugins-install-build-approved', { count: String(builds.length) })])
      return run()
    },
    async acceptRisk() {
      return stopped ? { kind: 'done' } : riskAndRetry()
    },
    async cancel() {
      // Already stopped: a second Esc must not ask again (the first answer is
      // the one that gets reported).
      if (stopped) return { kind: 'done' }
      stopped = true
      // Nothing was handed to the service yet: there is no run to stop, and
      // asking it to cancel one would only answer "not-running".
      if (!installStarted) return { kind: 'done' }
      try {
        const outcome = await options.manager.cancelInstall(requestId)
        emit([t(outcome.status === 'cancelled'
          ? 'plugins-install-cancelled'
          : outcome.status === 'too-late' ? 'plugins-install-cancel-too-late' : 'plugins-install-cancel-not-running')])
      } catch (error) {
        emit([t('plugins-install-cancel-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      }
      return { kind: 'done' }
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * The `/plugin install` entry the screen calls: `/plugin`'s argument text in, a
 * flow out — or `undefined` for anything that is not an install form, and for a
 * launch with no profile plugin service to install through (the screen then
 * runs the read-only report, which is where the CLI route is printed).
 *
 * This is the one place that knows how the flow is wired to the running
 * composition: the host service and its events, the packaged feed, gate 1's
 * declaration reader, and the profile-relative resolution of a `install <path>`
 * spec. It lives beside the flow rather than in the entry so a regression can
 * drive the real wiring with a fixture context — the parts that only exist here
 * (the feed load, the declaration read, the `file:` base URL) are exactly the
 * ones a fixture-only battery would otherwise never touch.
 */
export function createPluginInstallEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined; readonly ownVersion?: string | undefined } = {},
): (args: string, sink: PluginInstallSink) => PluginInstallFlow | undefined {
  return (args, sink) => {
    const parsed = parsePluginArgs(args)
    if (parsed.kind !== 'install' || parsed.spec === '') return undefined
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) return undefined
    return createPluginInstallFlow({
      manager,
      events: pluginInstallEvents(ctx),
      spec: parsed.spec,
      // Read once per install: the feed is a packaged file, and a request that is
      // never made should never touch the disk.
      feed: loadFirstPartyFeed(),
      noticeOf: target => declarationNoticeFor({
        ...target.name === undefined ? {} : { declaration: pluginDeclarationOf(ctx, target.name) },
        ...target.directory === undefined ? {} : { directory: target.directory },
      }),
      specDirectory: spec => specDirectoryOf(ctx, spec),
      binding: sink.binding,
      onLines: sink.onLines,
      ownVersion: options.ownVersion ?? installedTuiVersion(),
      profileName: options.profileName ?? resolveDshProfileName(),
    })
  }
}

/**
 * The directory a `install <path>` spec names, when it names one. Only a
 * directory has a package-root declaration to read — a tarball or git spec must
 * stay unjudged rather than be reported as "declares nothing".
 *
 * A relative spec is relative to the profile: `ctx.baseUrl` is the loader's base
 * for these rows, and it arrives as a `file:` URL (or a plain path on some
 * hosts) — the same pair `requireBase()` in `admission-loader.ts` accepts.
 * `path.resolve` on a URL would invent a path that never exists.
 */
function specDirectoryOf(ctx: Context, spec: string): string | undefined {
  if (!spec.startsWith('.') && !isAbsolute(spec)) return undefined
  const baseUrl = (ctx as { baseUrl?: string }).baseUrl
  let base = process.cwd()
  if (baseUrl !== undefined && baseUrl !== '') {
    try {
      base = baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : baseUrl
    } catch {
      base = process.cwd()
    }
  }
  const directory = resolve(base, spec)
  try {
    return statSync(directory).isDirectory() ? directory : undefined
  } catch {
    return undefined
  }
}
