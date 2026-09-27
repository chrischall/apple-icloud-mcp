/**
 * A sliding-window rate limiter for Apple's iTunes Search API.
 *
 * Apple documents the limit as "approximately 20 calls per minute" (per IP;
 * on a hosted deployment every tenant shares the pool's egress address). A
 * plain min-interval throttle (mcp-utils `createThrottle`) would make EVERY
 * call wait 3 s even when the server is idle, and a token bucket that refills
 * one call per 3 s lets 39 calls through in the first minute after a burst.
 * Neither is what Apple counts, so this limiter enforces the window itself:
 *
 *  - fewer than `maxCalls` starts in the trailing `windowMs` → run now;
 *  - otherwise wait until the oldest of them leaves the window, and (once the
 *    window is full) keep at least `minSpacingMs` between starts, so a
 *    saturated server settles into a steady one-call-per-3-s rhythm instead of
 *    re-bursting the moment the window turns over.
 *
 * Start times are RESERVED synchronously (FIFO), so concurrent calls line up
 * rather than all observing the same free slot. A call whose wait would exceed
 * `maxWaitMs` (or the call's own, shorter limit) is refused through
 * `refuse(waitMs)` WITHOUT reserving a slot — a clear "retry in N s" beats a
 * tool call that hangs until the client gives up.
 */
export interface SlidingWindowOptions {
  /** Starts allowed inside one window. */
  maxCalls: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Minimum spacing between starts, applied only while the window is full. */
  minSpacingMs: number;
  /** Longest a call may be made to wait before it is refused instead. */
  maxWaitMs: number;
  /** Builds the error a refused call throws. */
  refuse: (waitMs: number) => Error;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ScheduleOptions {
  /**
   * This call's own wait limit, overriding `maxWaitMs` (e.g. a health probe
   * that must answer inside the healthcheck's own timeout).
   */
  maxWaitMs?: number;
}

export type SlidingWindowLimiter = <T>(fn: () => Promise<T>, callOpts?: ScheduleOptions) => Promise<T>;

export function createSlidingWindowLimiter(opts: SlidingWindowOptions): SlidingWindowLimiter {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Reserved start times, ascending; only the newest `maxCalls` can matter, so no more are kept. */
  const starts: number[] = [];

  return async function schedule<T>(fn: () => Promise<T>, callOpts: ScheduleOptions = {}): Promise<T> {
    const current = now();
    const last = starts.length > 0 ? (starts[starts.length - 1] as number) : Number.NEGATIVE_INFINITY;
    // FIFO: never start before a call that was reserved earlier.
    let at = Math.max(current, last);
    if (starts.length >= opts.maxCalls) {
      // The window at `at` is full until the maxCalls-th newest start ages out of it.
      const opens = (starts[starts.length - opts.maxCalls] as number) + opts.windowMs;
      if (opens > at) at = Math.max(opens, last + opts.minSpacingMs);
    }
    const wait = at - current;
    if (wait > (callOpts.maxWaitMs ?? opts.maxWaitMs)) throw opts.refuse(wait);
    starts.push(at);
    if (starts.length > opts.maxCalls) starts.shift();
    if (wait > 0) await sleep(wait);
    return fn();
  };
}
