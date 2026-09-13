import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../helpers/clock.js';
import { LEDGER_EVENT_TYPES, fakeLedgerEvents } from '../../helpers/ledger.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fakeLedgerEvents', () => {
  it('is deterministic for equal seeds', () => {
    expect(fakeLedgerEvents(500, 42)).toEqual(fakeLedgerEvents(500, 42));
    expect(fakeLedgerEvents(50)).toEqual(fakeLedgerEvents(50));
  });

  it('differs for different seeds', () => {
    expect(fakeLedgerEvents(100, 42)).not.toEqual(fakeLedgerEvents(100, 43));
  });

  it('does not depend on wall-clock time or Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    const early = fakeLedgerEvents(300, 9);
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
    const late = fakeLedgerEvents(300, 9);
    expect(late).toEqual(early);
    expect(random).not.toHaveBeenCalled();
  });

  it('a shorter stream is a prefix of a longer one with the same seed', () => {
    expect(fakeLedgerEvents(10, 7)).toEqual(fakeLedgerEvents(100, 7).slice(0, 10));
  });

  it('returns exactly n events for one run with strictly increasing seq and unique ids', () => {
    expect(fakeLedgerEvents(0, 1)).toEqual([]);
    const events = fakeLedgerEvents(2000, 5);
    expect(events).toHaveLength(2000);
    expect(new Set(events.map((e) => e.run_id)).size).toBe(1);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    expect(events[0]!.type).toBe('run.created');
    for (const e of events) {
      expect(LEDGER_EVENT_TYPES).toContain(e.type);
      expect(['agent', 'runtime', 'human']).toContain(e.actor);
    }
  });

  it('acknowledges a tool call only after it was requested', () => {
    const requested = new Set<unknown>();
    for (const e of fakeLedgerEvents(2000, 11)) {
      if (e.type === 'tool.requested') requested.add(e.payload.tool_call_id);
      if (e.type === 'tool.completed' || e.type === 'tool.failed') {
        expect(requested.has(e.payload.tool_call_id)).toBe(true);
      }
    }
    expect(requested.size).toBeGreaterThan(0);
  });

  it('rejects an invalid n', () => {
    expect(() => fakeLedgerEvents(-1)).toThrow(RangeError);
    expect(() => fakeLedgerEvents(1.5)).toThrow(RangeError);
  });
});

describe('fixedClock', () => {
  it('advances only via tick()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const clock = fixedClock(1_000);
    expect(clock.now()).toBe(1_000);

    vi.advanceTimersByTime(60_000);
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(clock.now()).toBe(1_000);

    clock.tick(250);
    expect(clock.now()).toBe(1_250);
    clock.tick(0);
    expect(clock.now()).toBe(1_250);
  });

  it('rejects negative or non-finite ticks without moving', () => {
    const clock = fixedClock(0);
    expect(() => clock.tick(-1)).toThrow(RangeError);
    expect(() => clock.tick(Number.NaN)).toThrow(RangeError);
    expect(() => clock.tick(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(clock.now()).toBe(0);
  });

  it('clocks are independent', () => {
    const a = fixedClock(0);
    const b = fixedClock(0);
    a.tick(5);
    expect(a.now()).toBe(5);
    expect(b.now()).toBe(0);
  });

  it('rejects a non-finite start', () => {
    expect(() => fixedClock(Number.NaN)).toThrow(TypeError);
  });
});
