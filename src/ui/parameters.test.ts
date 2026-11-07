import { describe, expect, it, vi } from 'vitest';

// The dialog module imports `icon()` from icons.ts, which builds a DOMParser
// when it is first imported. Under the Node test runner that global is absent,
// so provide a minimal one before the module under test is imported — the
// dialog's DOM is never built here, only its pure helpers are exercised.
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: class {
      parseFromString(): unknown {
        return {};
      }
    },
  });
});

import { Translator } from '../i18n/i18n';
import { nextParamName, paramErrorMessage } from './parameters';

const zh = new Translator('zh-CN');
const en = new Translator('en');

// DOM behavior (focus trap, Esc, backdrop click) needs a real document and is
// exercised in the browser preview; only the pure helpers are unit-tested here.
describe('nextParamName', () => {
  it('starts at d0 on an empty sketch', () => {
    expect(nextParamName({})).toBe('d0');
  });

  it('takes the lowest free d-index after the existing ones', () => {
    expect(nextParamName({ d0: 1 })).toBe('d1');
    expect(nextParamName({ d0: 1, d5: 2 })).toBe('d1');
    expect(nextParamName({ d0: 1, d1: 2, d2: 3 })).toBe('d3');
  });

  it('ignores names that are not d-indexed', () => {
    expect(nextParamName({ a: 1, b: 2 })).toBe('d0');
    expect(nextParamName({ width: 10, height: 20 })).toBe('d0');
  });

  it('only counts the canonical d<i> spelling', () => {
    expect(nextParamName({ d00: 1 })).toBe('d0');
  });
});

describe('paramErrorMessage', () => {
  it('names the rule a bad name broke', () => {
    expect(paramErrorMessage('invalidName', en)).toEqual({
      key: 'parameters.invalidName',
      params: {},
    });
    expect(paramErrorMessage('duplicateName', en)).toEqual({
      key: 'parameters.duplicateName',
      params: {},
    });
  });

  it('reports a dependency cycle on its own key', () => {
    expect(paramErrorMessage('cycle', en)).toEqual({ key: 'parameters.cycle', params: {} });
  });

  it('reads every expression error as a syntax problem', () => {
    for (const error of [
      'syntax',
      'arity',
      'unknownFunction',
      'divisionByZero',
      'domain',
      'notFinite',
      'unexpectedEnd',
    ]) {
      expect(paramErrorMessage(error, en)).toEqual({ key: 'parameters.syntax', params: {} });
    }
  });

  it('carries the unknown name from the detail into the message params', () => {
    expect(paramErrorMessage('unknownName', en, 'd3')).toEqual({
      key: 'parameters.unknownName',
      params: { name: 'd3' },
    });
    expect(paramErrorMessage('unknownName', en)).toEqual({
      key: 'parameters.unknownName',
      params: { name: '' },
    });
  });

  it('carries the reference count into the message params', () => {
    expect(paramErrorMessage('inUse', en, undefined, 3)).toEqual({
      key: 'parameters.inUse',
      params: { count: 3 },
    });
    expect(paramErrorMessage('inUse', en)).toEqual({
      key: 'parameters.inUse',
      params: { count: 0 },
    });
  });

  it('maps a failed solve to the status message', () => {
    expect(paramErrorMessage('solveFailed', en)).toEqual({ key: 'status.solveFailed', params: {} });
  });

  it('falls back to a syntax problem for anything unrecognized', () => {
    expect(paramErrorMessage('mystery', en)).toEqual({ key: 'parameters.syntax', params: {} });
  });

  it('does not depend on the locale', () => {
    expect(paramErrorMessage('cycle', zh)).toEqual(paramErrorMessage('cycle', en));
    expect(paramErrorMessage('unknownName', zh, 'd3')).toEqual(
      paramErrorMessage('unknownName', en, 'd3'),
    );
  });
});
