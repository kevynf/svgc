import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
});

import { INFERRED_KINDS } from '../editor/settings';
import type { InferredKind } from '../editor/settings';
import { Translator } from '../i18n/i18n';
import { inferenceRows, inferenceSummary } from './constraint-settings';

const zh = new Translator('zh-CN');
const en = new Translator('en');

const set = (...kinds: InferredKind[]): ReadonlySet<InferredKind> => new Set(kinds);

describe('inferenceSummary', () => {
  it('reports a full set in both locales', () => {
    const all = set(...INFERRED_KINDS);
    expect(inferenceSummary(all, zh)).toBe('已推断 7 / 7 种约束');
    expect(inferenceSummary(all, en)).toBe('7 of 7 constraint types inferred');
  });

  it('reports a partial set in both locales', () => {
    const some = set('coincident', 'horizontal', 'vertical', 'parallel', 'tangent');
    expect(inferenceSummary(some, zh)).toBe('已推断 5 / 7 种约束');
    expect(inferenceSummary(some, en)).toBe('5 of 7 constraint types inferred');
  });

  it('reports an empty set in both locales', () => {
    const none = set();
    expect(inferenceSummary(none, zh)).toBe('已推断 0 / 7 种约束');
    expect(inferenceSummary(none, en)).toBe('0 of 7 constraint types inferred');
  });
});

describe('inferenceRows', () => {
  it('has one row per inference kind, in INFERRED_KINDS order', () => {
    expect(inferenceRows().map((r) => r.kind)).toEqual([...INFERRED_KINDS]);
  });

  it('maps every kind to its constraint glyph and label key', () => {
    expect(inferenceRows()).toEqual([
      { kind: 'coincident', glyph: 'coincident', labelKey: 'settings.kinds.coincident' },
      { kind: 'pointOnCurve', glyph: 'pointOnCurve', labelKey: 'settings.kinds.pointOnCurve' },
      { kind: 'horizontal', glyph: 'horizontal', labelKey: 'settings.kinds.horizontal' },
      { kind: 'vertical', glyph: 'vertical', labelKey: 'settings.kinds.vertical' },
      { kind: 'parallel', glyph: 'parallel', labelKey: 'settings.kinds.parallel' },
      { kind: 'perpendicular', glyph: 'perpendicular', labelKey: 'settings.kinds.perpendicular' },
      { kind: 'tangent', glyph: 'tangent', labelKey: 'settings.kinds.tangent' },
    ]);
  });
});
