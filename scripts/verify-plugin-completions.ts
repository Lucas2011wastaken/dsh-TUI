/**
 * 批 C-3 补全面：`/plugin info <name>` 补全行的描述是插件自己的元数据。
 *
 *   A. 净化：标题里的换行不得越出弹窗行，ANSI 不得留在缓存里（组合后过
 *      cleanScalarText）；
 *   B. 限宽：超宽标题（含东亚宽字符）在缓存里就有界，不靠渲染期兜底；
 *   C. 语言：缓存一次装入所有 shipped 语言，`/lang` 后弹窗与 `/plugin info`
 *      的标题一致 —— 不重启、不重新 warm；
 *   D. 端到端：真实 CommandSuggestions 在 100/50 列下，注入的标题不会多出
 *      一条没有左边框的行（修复前的实际症状）。
 *
 * 插件服务是替身：不装、不卸、不联网、不读用户状态。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-completions.ts`.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandCompletionNode } from '../src/commands.js'

// ── 隔离 HOME（必须先于任何 src 导入：i18n 的偏好目录在导入时定下）─────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-completions-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'

const [{ createPluginCompletionCatalog }, { setLang }, { completeCommands, localizedDescription }, { pluginReport }, { stringWidth }, React, { Terminal }, { CommandSuggestions }, { Writable }, ui, { settled, viewportLines, writeParsed }] = await Promise.all([
  import('../src/dsh-adapter/plugin-completions.js'),
  import('../src/i18n.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/plugins-info.js'),
  import('../src/ink/stringWidth.js'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/CommandSuggestions.js'),
  import('node:stream'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** 微任务排空：目录的 async 链只有微任务，一个宏任务边界就够。 */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const TITLE_EN = 'English title'
const TITLE_ZH = '中文标题'
const VERSION = '1.0.0'
const bundle = (title: unknown) => ({
  name: 'probe-plugin', version: VERSION, installed: true, optional: false,
  enabled: true, removable: true, rows: [], overrides: [], meta: { title },
})

/** 目录只读它的服务；其余字段给报告用。 */
const services = (item: ReturnType<typeof bundle>) => ({
  listBundles: async () => [item],
  listPlugins: async () => [],
})
const catalogOf = (item: ReturnType<typeof bundle>) => createPluginCompletionCatalog(
  { get: () => services(item) } as never,
  { owner: { current: () => true, signal: new AbortController().signal }, emit() {} },
)
const warmed = async (item: ReturnType<typeof bundle>) => {
  const catalog = catalogOf(item)
  catalog.warmPluginNames()
  await tick()
  return catalog.pluginNames()[0]!
}

// ── A/B. 不可信标题：换行、ANSI、超宽 ───────────────────────────────────────
const injected = await warmed(bundle({ en: 'first\nINJECTED-LINE', zh: `\u001b[31m${'界'.repeat(300)}\u001b[0m` }))
check('a newline in a title cannot leave the popup row',
  !injected.description.includes('\n') && injected.description.includes('first INJECTED-LINE'), JSON.stringify(injected.description))
check('an ANSI title is stripped before it is cached',
  !injected.description.includes('\u001b') &&
  Object.values(injected.descriptions ?? {}).every(text => !text.includes('\u001b')), JSON.stringify(injected.descriptions))

setLang('zh')
const wide = localizedDescription(injected)
check('a wide title is bounded in display cells',
  stringWidth(wide) <= 200 && wide.endsWith('…'), `${stringWidth(wide)} cells: ${JSON.stringify(wide.slice(0, 40))}`)
setLang('en')

// ── C. 语言：一次 warm，两种语言 ────────────────────────────────────────────
const localized = await warmed(bundle({ en: TITLE_EN, zh: TITLE_ZH }))
check('the popup titles a bundle in the language it was warmed in',
  localizedDescription(localized) === `${TITLE_EN} · ${VERSION}`, JSON.stringify(localized.description))
setLang('zh')
check('/lang repaints the same cached row without a reload',
  localizedDescription(localized) === `${TITLE_ZH} · ${VERSION}`, JSON.stringify(localized.description))

const probeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-completions-report-'))
const deps = {
  grants: { knownPermissions: () => [], allows: () => false },
  dataDir: probeHome,
  ledgerFile: join(probeHome, 'ledger.jsonl'),
  storageDir: probeHome,
}
const report = await pluginReport('info probe-plugin', deps as never, services(bundle({ en: TITLE_EN, zh: TITLE_ZH })) as never)
check('the popup and /plugin info agree on the title',
  report.some(line => line.includes(TITLE_ZH)) && localizedDescription(localized).startsWith(TITLE_ZH), report.join('\n'))

// ── D. 端到端：真实弹窗，两种宽度 ───────────────────────────────────────────
/** 含 `marker` 的行必须恰好一条、且带卡片左边框：修复前注入的标题会多出一条
 *  没有左边框的行（100 与 50 列都实测如此）。 */
const borderedOnce = (rows: readonly string[], marker: string): boolean => {
  const hits = rows.filter(line => line.includes(marker))
  return hits.length === 1 && hits[0]!.trimStart().startsWith('│')
}

const popup = (nodes: readonly CommandCompletionNode[]): ReturnType<typeof completeCommands> => completeCommands(
  '/plugin info ',
  [{ name: 'plugin', description: '' }],
  segments => segments.length === 1 ? [{ name: 'info', description: '' }] : nodes,
)
/** 一屏弹窗：`rows()` 读视口，`close()` 收尾。 */
async function renderPopup(commands: ReturnType<typeof popup>, columns: number): Promise<{ rows(): string[]; close(): Promise<void> }> {
  const term = new Terminal({ cols: columns, rows: 12, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = columns
    rows = 12
    isTTY = true
    _write(chunk: unknown, _encoding: string, callback: () => void): void { term.write(String(chunk), callback) }
  }
  const app = await ui.render(React.createElement(CommandSuggestions, { commands, selectedIndex: 0, columns }), {
    stdout: new Out() as never, exitOnCtrlC: false, patchConsole: false,
  })
  return {
    rows: () => viewportLines(term, 12),
    close: async () => {
      app.unmount()
      await writeParsed(term, '')
      term.dispose()
    },
  }
}

// 语言此刻是 zh，而这一行是在 en 下 warm 的：弹窗按渲染时的语言取标题。
for (const columns of [100, 50]) {
  const zh = await renderPopup(popup([localized]), columns)
  check(`${columns} columns: the popup shows the title of the language active at render`,
    await settled(() => zh.rows().some(line => line.includes(TITLE_ZH))), zh.rows().join('\n'))
  check(`${columns} columns: the localized title stays inside its row`,
    borderedOnce(zh.rows(), TITLE_ZH), zh.rows().join('\n'))
  await zh.close()
}

setLang('en')
for (const columns of [100, 50]) {
  const rows = await renderPopup(popup([injected]), columns)
  check(`${columns} columns: a newline in a title cannot add a borderless row`,
    await settled(() => rows.rows().some(line => line.includes('INJECTED-LINE'))) &&
    borderedOnce(rows.rows(), 'INJECTED-LINE'), rows.rows().join('\n'))
  await rows.close()
}

console.log(`verify-plugin-completions OK (${passed} checks)`)
