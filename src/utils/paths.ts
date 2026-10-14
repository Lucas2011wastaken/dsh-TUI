/**
 * Data-directory paths for the dsh-tui profile. All preferences and history
 * live under `~/.dsh-tui`.
 *
 * The compiled copy (lib/types/utils/paths.js) is also imported by the bin
 * launcher, mirroring the shellQuote precedent.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's home directory. `os.homedir()` first; the USERPROFILE/HOME
 * spellings are the last-resort fallback for stripped-down environments.
 * @returns Absolute home path.
 */
export function homeDir(): string {
  return homedir() || process.env.USERPROFILE || process.env.HOME || ''
}

/** Data directory all preferences/history live in (`~/.dsh-tui`). */
export const DATA_DIR = join(homeDir(), '.dsh-tui')

/**
 * Where one backend keeps its own files: `<DATA_DIR>/backends/<id>`, keyed by
 * the backend's declared id (`BackendContribution.id`, the `x-dsh-tui` entry's
 * `id` field). The single construction point, so a check for what a removal
 * left behind reads the same path the backend wrote to (C-5).
 */
export function backendDataDir(backendId: string): string {
  return join(DATA_DIR, 'backends', backendId)
}
