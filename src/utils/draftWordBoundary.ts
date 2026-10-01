import { getWordSegmenter } from './intl.js'

/**
 * Word boundaries for the prompt draft, shared by `Ctrl+Z` undo grouping and
 * `Ctrl+W` kill-word so both agree on what a "word" is. Three layers, in
 * priority order:
 *
 * 1. Hard breaks, regex only: either edge, whitespace/newline, a CJK
 *    punctuation mark, or a script change (Han / Latin / digit / kana /
 *    hangul / other).
 * 2. ICU arbitration, only when layer 1 missed: segment a window around the
 *    seam with `Intl.Segmenter` (`granularity: 'word'`) and accept a segment
 *    start that lands exactly on the seam. The window is both a cost bound
 *    (segmenting a 30k draft costs ~15ms and would drop frames) and a
 *    correctness matter: ICU's dictionary segmentation is length-dependent,
 *    so a minimal two-character splice disagrees with the full context (a
 *    run of repeated Han characters is the reproducible case).
 * 3. Idle coalescing is deliberately NOT here: the undo stack applies its own
 *    700ms rule so a test clock can be injected at that call site.
 */

/** Window radius (characters) for the ICU layer, and its scan budget. */
export const DRAFT_WORD_WINDOW = 32

const WHITESPACE = /\s/u
const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL = /\p{Script=Hangul}/u
const LATIN = /\p{Script=Latin}/u
const DIGIT = /\p{N}/u
/**
 * CJK/fullwidth punctuation always severs a word: ，。！？、；：""''（）《》【】
 * plus the rest of the CJK Symbols, Halfwidth/Fullwidth Forms and the
 * curly-quote/ellipsis/em-dash block.
 */
const CJK_PUNCT =
  /[\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u
/** Grapheme-cluster continuations: combining marks, ZWJ, variation selectors. */
const JOINER = /[\p{M}\u200d\ufe00-\ufe0f]/u

const CLASS_OTHER = 0
const CLASS_LATIN = 1
const CLASS_DIGIT = 2
const CLASS_HAN = 3
const CLASS_KANA = 4
const CLASS_HANGUL = 5

/** Code point ending at `index`, surrogate-pair aware. */
function codePointBefore(text: string, index: number): number {
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
    }
  }
  return low
}

function scriptClass(codePoint: number): number {
  const char = String.fromCodePoint(codePoint)
  if (HAN.test(char)) return CLASS_HAN
  if (KANA.test(char)) return CLASS_KANA
  if (HANGUL.test(char)) return CLASS_HANGUL
  if (DIGIT.test(char)) return CLASS_DIGIT
  if (LATIN.test(char)) return CLASS_LATIN
  return CLASS_OTHER
}

/** Continuation of a grapheme cluster: combining mark, ZWJ, variation selector. */
function isClusterJoiner(codePoint: number): boolean {
  return JOINER.test(String.fromCodePoint(codePoint))
}

/**
 * Script class of the character before `offset`, skipping any trailing
 * cluster joiners so `e` + U+0301 classifies as Latin, not "other".
 */
function leftClassAt(text: string, offset: number): number {
  let index = offset
  while (index > 0) {
    const codePoint = codePointBefore(text, index)
    if (!isClusterJoiner(codePoint)) return scriptClass(codePoint)
    index = stepBackward(text, index)
  }
  return CLASS_OTHER
}

/** Layer 1 only: cheap, context-free break rules (edges count as breaks). */
function hardBoundaryAt(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true
  const right = text.codePointAt(offset)!
  // A joining mark on the right means the seam sits INSIDE a grapheme
  // cluster — never a word boundary, whatever the base character's class.
  if (isClusterJoiner(right)) return false
  const left = codePointBefore(text, offset)
  const leftChar = String.fromCodePoint(left)
  const rightChar = String.fromCodePoint(right)
  if (WHITESPACE.test(leftChar) || WHITESPACE.test(rightChar)) return true
  if (CJK_PUNCT.test(leftChar) || CJK_PUNCT.test(rightChar)) return true
  return leftClassAt(text, offset) !== scriptClass(right)
}

function isWhitespaceAt(text: string, index: number): boolean {
  return WHITESPACE.test(String.fromCodePoint(text.codePointAt(index)!))
}

/** Next code-point index after `index` (never splits a surrogate pair). */
function stepForward(text: string, index: number): number {
  const codePoint = text.codePointAt(index)!
  return index + (codePoint > 0xffff ? 2 : 1)
}

/** Previous code-point index before `index` (never splits a surrogate pair). */
function stepBackward(text: string, index: number): number {
  const codePoint = codePointBefore(text, index)
  return codePoint > 0xffff ? index - 2 : index - 1
}

/**
 * Whether the seam at `offset` (`text[offset-1] | text[offset]`) is a word
 * boundary. `offset` is a code-unit index, as produced by the composer's
 * grapheme-normalized caret.
 */
export function isDraftWordBoundary(text: string, offset: number): boolean {
  if (hardBoundaryAt(text, offset)) return true
  const segmenter = getWordSegmenter()
  // No ICU: layer 1 above is the whole answer — its hard breaks (whitespace,
  // CJK punctuation, script change) are what a dictionary would refine.
  if (segmenter === undefined) return false
  const start = Math.max(0, offset - DRAFT_WORD_WINDOW)
  const end = Math.min(text.length, offset + DRAFT_WORD_WINDOW)
  // Layer 1 rejected this offset, so 0 < offset < text.length, which means
  // start < offset < end: the window's own edges can never masquerade as a
  // seam boundary, and the queried offset is always strictly inside.
  for (const part of segmenter.segment(text.slice(start, end))) {
    if (start + part.index === offset) return true
  }
  return false
}

/**
 * Index of the word boundary at or before `offset`, skipping whitespace
 * first (readline `Ctrl+W` / `alt+b` geometry). Mirrors the whitespace-based
 * helper it replaces for space-delimited text.
 */
export function draftWordBoundaryLeft(text: string, offset: number): number {
  let index = offset
  while (index > 0 && isWhitespaceAt(text, index - 1)) index--
  if (index === 0) return 0
  let steps = 0
  for (let probe = stepBackward(text, index); probe > 0; probe = stepBackward(text, probe), steps++) {
    // Beyond the window the ICU layer cannot see the context anyway, so the
    // scan continues on the cheap hard rules instead of paying ~33µs/char
    // on a pathologically long single token.
    const boundary =
      steps < DRAFT_WORD_WINDOW ? isDraftWordBoundary(text, probe) : hardBoundaryAt(text, probe)
    if (boundary) return probe
  }
  return 0
}

/**
 * Index of the word boundary just past the current word and its trailing
 * whitespace (readline `alt+f` geometry), mirroring the whitespace-based
 * helper it replaces for space-delimited text.
 */
export function draftWordBoundaryRight(text: string, offset: number): number {
  const length = text.length
  let index = offset < length ? stepForward(text, offset) : length
  let steps = 0
  for (; index < length; index = stepForward(text, index), steps++) {
    const boundary =
      steps < DRAFT_WORD_WINDOW ? isDraftWordBoundary(text, index) : hardBoundaryAt(text, index)
    if (boundary) break
  }
  while (index < length && isWhitespaceAt(text, index)) index = stepForward(text, index)
  return index
}
