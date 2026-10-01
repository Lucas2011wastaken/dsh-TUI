let graphemeSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with grapheme granularity for width-aware string
 * handling in the renderer and terminal parser.
 * @returns The shared grapheme segmenter, created once on first use.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }))
}

// Node >= 13 ships full ICU, but a stripped or embedder-supplied runtime may
// not expose the constructor at all. Callers then keep layer 1's hard breaks
// (whitespace / CJK punctuation / script change) only.
const hasWordSegmenter = typeof Intl.Segmenter === 'function'
let wordSegmenter: Intl.Segmenter | undefined

/**
 * Memoized `Intl.Segmenter` with word granularity (UAX #29 + ICU dictionary)
 * for the prompt draft's word boundaries. Locale is fixed to `'en'`: it
 * matches `getGraphemeSegmenter`, and measured Han/kana results are identical
 * to `'zh'`/`'ja'` for the segmentation the draft needs.
 * @returns The shared word segmenter, or `undefined` without `Intl.Segmenter`.
 */
export function getWordSegmenter(): Intl.Segmenter | undefined {
  if (!hasWordSegmenter) return undefined
  return (wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' }))
}
