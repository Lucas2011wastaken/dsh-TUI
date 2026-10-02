/**
 * Regression for the mid-turn command impact table (issue #1072): the channel
 * gates and the `/` suggestion overlay must read ONE source of truth, so the
 * refusal notice and the "affects this conversation" grouping can never drift.
 *
 *  1. every gated command name is a real local command with a parseable line;
 *  2. every gate notice key exists in the i18n dictionary;
 *  3. the conversation-acting names are local commands and disjoint from
 *     the gated set;
 *  4. `workingHoldOf` classifies completion paths, root tokens, skills and the
 *     normal region as documented;
 *  5. no gate key is still written as a `t('<key>')` literal anywhere in src/ —
 *     all 11 call sites have to go through the table.
 *
 * Run: node --import tsx/esm scripts/verify-command-hold.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  BACKEND_CHANNEL_COMMAND,
  LOCAL_COMMANDS,
  WORKING_CONVERSATION_COMMANDS,
  WORKING_GATE_NOTICES,
  parseCommandName,
  workingHoldOf,
} from '../src/commands.js'
import { i18nDict } from '../src/i18n.js'

// `/channel` is not in the static roster: a backend serves it only when it
// declares the typed `channels` capability (`core/session-controls.ts`), so the
// typed name is the second place a gated command can come from.
const isLocal = (name: string): boolean =>
  LOCAL_COMMANDS.some(command => command.name === name) || BACKEND_CHANNEL_COMMAND.name === name

// ── 1+2: the gated set names real commands with real notices ───────────────
const gated = Object.keys(WORKING_GATE_NOTICES)
assert.deepEqual(gated, [
  'new', 'compact', 'fork', 'model', 'preset', 'workspace', 'update', 'restart',
  'resume', 'rewind', 'kernel', 'channel',
])
for (const name of gated) {
  assert.ok(isLocal(name), `gated command ${name} must exist in LOCAL_COMMANDS`)
  assert.equal(parseCommandName(`/${name}`)?.name, name, `/${name} must parse as a command line`)
  const key = WORKING_GATE_NOTICES[name as keyof typeof WORKING_GATE_NOTICES]
  assert.notEqual(i18nDict[key], undefined, `gate notice ${key} (${name}) must exist in the i18n dictionary`)
  assert.equal(workingHoldOf(name), 'gated', `${name} must classify as gated`)
}

// ── 3: the conversation-acting set is local and disjoint ───────────────────
for (const name of WORKING_CONVERSATION_COMMANDS) {
  assert.ok(isLocal(name), `conversation command ${name} must exist in LOCAL_COMMANDS`)
  assert.equal(workingHoldOf(name), 'conversation', `${name} must classify as conversation`)
  assert.ok(!gated.includes(name), `${name} cannot be both gated and conversation`)
}

// ── 4: classification, including completion paths and skills ───────────────
assert.equal(workingHoldOf('model deepseek/x'), 'gated', 'a completion path inherits its root hold')
assert.equal(workingHoldOf('/workspace rename w'), 'gated', 'a leading slash and arguments are tolerated')
assert.equal(workingHoldOf('MODEL'), 'gated', 'classification is case-insensitive')
assert.equal(workingHoldOf(' model '), 'gated', 'surrounding whitespace is tolerated')
assert.equal(workingHoldOf('audit', true), 'inject', 'a skill steers into the running turn')
assert.equal(workingHoldOf('model', true), 'inject', 'skill wins over the gated root (registry gesture)')
for (const name of ['status', 'btw', 'skills', 'bg', 'theme', '/', '']) {
  assert.equal(workingHoldOf(name), undefined, `${JSON.stringify(name)} belongs to the normal region`)
}
// Browsing is NOT impact: `/tree` only calls `setTreeOpen(true)` and leaves the
// running turn untouched (measured on a real turn, issue #1072 review), so it
// stays in the normal region even though its per-node actions can cancel.
// `/rewind` used to sit in the conversation family for the same "its purpose is
// to replace the conversation" reason; under DSH the extension still cancels the
// turn and re-arms (`session-rewind.ts`), but the core's own rewind path REFUSES
// mid-turn (`core/sessions.ts`), and one command cannot be classified twice — so
// it is gated, like `/resume`.
assert.equal(workingHoldOf('tree'), undefined, '/tree inspects the session tree; it does not interrupt')
assert.equal(workingHoldOf('rewind'), 'gated', '/rewind is refused by the core while a turn runs')
assert.equal(workingHoldOf('clear'), 'conversation', '/clear acts on the conversation view itself')
for (const name of ['tree']) {
  assert.ok(!WORKING_CONVERSATION_COMMANDS.includes(name), `/${name} must not be listed as a hold`)
}

// ── 5: every gate goes through the table ────────────────────────────────────
const files = [...new Set(execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'],
  { encoding: 'utf8' },
).split('\0'))]
  .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
  .filter(file => file !== 'src/commands.ts' && file !== 'src/i18n.ts')
for (const key of new Set(Object.values(WORKING_GATE_NOTICES))) {
  for (const file of files) {
    if (!existsSync(file)) continue
    assert.ok(
      !readFileSync(file, 'utf8').includes(`t('${key}')`),
      `${file}: ${key} must be read from WORKING_GATE_NOTICES, not a literal`,
    )
  }
}

console.log(`verify-command-hold OK: ${gated.length} gated, ${WORKING_CONVERSATION_COMMANDS.length} conversation-acting`)
