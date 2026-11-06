import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AliasMatcher } from './aliases';

const ALIASES = [
  ['L', 'line'],
  ['C', 'circle'],
  ['REC', 'rectangle'],
  ['A', 'arc-center'],
  ['A3', 'arc'],
  ['=', 'equal'],
] as const;

describe('AliasMatcher', () => {
  let fired: string[];
  let m: AliasMatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    fired = [];
    m = new AliasMatcher(ALIASES, (c) => fired.push(c), 500);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires an unambiguous single-key alias immediately, case-insensitively', () => {
    expect(m.feed('l')).toBe(true);
    expect(fired).toEqual(['line']);
  });

  it('fires a multi-letter alias on its last key', () => {
    m.feed('R');
    m.feed('E');
    expect(fired).toEqual([]);
    m.feed('C');
    expect(fired).toEqual(['rectangle']);
  });

  it('waits when an alias is a prefix of a longer one', () => {
    m.feed('A');
    expect(fired).toEqual([]);
    m.feed('3');
    expect(fired).toEqual(['arc']);

    m.feed('A');
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(['arc', 'arc-center']);
  });

  it('fires a pending alias on flush', () => {
    m.feed('A');
    expect(m.flush()).toBe(true);
    expect(fired).toEqual(['arc-center']);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual(['arc-center']);
  });

  it('restarts from the current key when the buffer stops matching', () => {
    m.feed('R');
    m.feed('L');
    expect(fired).toEqual(['line']);
  });

  it('ignores keys that start no alias', () => {
    expect(m.feed('Q')).toBe(false);
    expect(m.pending).toBe('');
  });

  it('supports symbol aliases', () => {
    m.feed('=');
    expect(fired).toEqual(['equal']);
  });
});
