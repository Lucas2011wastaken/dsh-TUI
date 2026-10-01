/**
 * Injectable clock seam for the prompt draft's undo coalescing.
 *
 * The 700ms idle rule must be testable without a real wait: a regression
 * script replaces the implementation and advances it by hand instead of
 * sleeping (a wall-clock sleep would make the suite flaky under load).
 * Production never calls {@link setNowImpl}.
 */
let nowImpl: () => number = Date.now

/** Current wall-clock time in milliseconds. */
export function nowMs(): number {
  return nowImpl()
}

/** Replace the clock implementation (tests only). */
export function setNowImpl(impl: () => number): void {
  nowImpl = impl
}

/** Restore the default clock (tests only). */
export function resetNowImpl(): void {
  nowImpl = Date.now
}
