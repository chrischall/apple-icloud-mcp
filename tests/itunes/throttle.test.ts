import { describe, expect, it, vi } from 'vitest';
import { createSlidingWindowLimiter } from '../../src/itunes/throttle.js';

function clockLimiter(opts: { maxCalls?: number; windowMs?: number; minSpacingMs?: number; maxWaitMs?: number } = {}) {
  let t = 0;
  const sleeps: number[] = [];
  const limiter = createSlidingWindowLimiter({
    maxCalls: opts.maxCalls ?? 20,
    windowMs: opts.windowMs ?? 60_000,
    minSpacingMs: opts.minSpacingMs ?? 3_000,
    maxWaitMs: opts.maxWaitMs ?? 30_000,
    refuse: (wait) => new Error(`refused ${wait}`),
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return {
    limiter,
    sleeps,
    at: (ms: number) => {
      t = ms;
    },
    now: () => t,
  };
}

describe('createSlidingWindowLimiter', () => {
  it('runs immediately while fewer than maxCalls started in the window', async () => {
    const c = clockLimiter();
    for (let i = 0; i < 20; i++) {
      c.at(i * 100);
      await expect(c.limiter(async () => i)).resolves.toBe(i);
    }
    expect(c.sleeps).toEqual([]);
  });

  it('once the window is full, waits until the oldest start leaves it', async () => {
    const c = clockLimiter();
    for (let i = 0; i < 20; i++) {
      c.at(i * 1000); // 0 … 19 s
      await c.limiter(async () => undefined);
    }
    c.at(40_000);
    // Oldest start (0 s) leaves the window at 60 s; 19 s + 3 s spacing is earlier, so 60 s wins.
    await c.limiter(async () => undefined);
    expect(c.sleeps).toEqual([20_000]);
    expect(c.now()).toBe(60_000);
  });

  it('keeps at least minSpacingMs between starts while the window is full', async () => {
    const c = clockLimiter();
    c.at(0);
    await c.limiter(async () => undefined);
    c.at(59_000);
    for (let i = 0; i < 19; i++) await c.limiter(async () => undefined);
    c.at(59_500);
    // The window opens at 60 s, but the last start was 59 s → spacing pushes it to 62 s.
    await c.limiter(async () => undefined);
    expect(c.sleeps).toEqual([2_500]);
    expect(c.now()).toBe(62_000);
  });

  it('refuses (without reserving a slot) when the wait would exceed maxWaitMs', async () => {
    const c = clockLimiter();
    for (let i = 0; i < 20; i++) await c.limiter(async () => undefined);
    const fn = vi.fn(async () => 'ran');
    await expect(c.limiter(fn)).rejects.toThrow('refused 60000');
    expect(fn).not.toHaveBeenCalled();
    // The refusal took no slot: at 40 s the wait is exactly 20 s.
    c.at(40_000);
    await expect(c.limiter(fn)).resolves.toBe('ran');
    expect(c.sleeps).toEqual([20_000]);
  });

  it('a call may set a shorter wait limit of its own; the refusal reserves nothing', async () => {
    const c = clockLimiter();
    for (let i = 0; i < 20; i++) await c.limiter(async () => undefined);
    c.at(50_000);
    const fn = vi.fn(async () => 'ran');
    await expect(c.limiter(fn, { maxWaitMs: 5_000 })).rejects.toThrow('refused 10000');
    expect(fn).not.toHaveBeenCalled();
    await expect(c.limiter(fn, { maxWaitMs: 10_000 })).resolves.toBe('ran');
    expect(c.sleeps).toEqual([10_000]);
  });

  it('never lets more than maxCalls start inside any window, even for concurrent callers', async () => {
    // Seven calls at t=0: each one's start time is its wait, since the clock never moves.
    const waits: number[] = [];
    const limiter = createSlidingWindowLimiter({
      maxCalls: 3,
      windowMs: 1_000,
      minSpacingMs: 100,
      maxWaitMs: 10_000,
      refuse: () => new Error('refused'),
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await Promise.all(Array.from({ length: 7 }, () => limiter(async () => undefined)));
    const starts = [0, 0, 0, ...waits];
    // Reservations are taken synchronously, in call order (FIFO).
    expect(starts).toEqual([0, 0, 0, 1_000, 1_000, 1_000, 2_000]);
    for (const s of starts) {
      expect(starts.filter((x) => x > s - 1_000 && x <= s).length).toBeLessThanOrEqual(3);
    }
  });

  it('a task that throws still counts and does not stall the next one', async () => {
    const c = clockLimiter({ maxCalls: 1, windowMs: 1_000, minSpacingMs: 0 });
    await expect(c.limiter(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(c.limiter(async () => 'next')).resolves.toBe('next');
    expect(c.sleeps).toEqual([1_000]);
  });

  it('uses the real clock and timers by default', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const limiter = createSlidingWindowLimiter({
      maxCalls: 1,
      windowMs: 500,
      minSpacingMs: 0,
      maxWaitMs: 1_000,
      refuse: () => new Error('refused'),
    });
    await limiter(async () => undefined);
    let done = false;
    const second = limiter(async () => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(done).toBe(true);
  });
});
