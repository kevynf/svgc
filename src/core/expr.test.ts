import { describe, expect, it } from 'vitest';
import {
  ExprError,
  evaluate,
  evaluateSource,
  findCycle,
  format,
  isValidName,
  parse,
  references,
  resolveParams,
} from './expr';
import type { ParamDef } from './expr';

const noLookup = (): undefined => undefined;

function errorOf(run: () => unknown): ExprError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ExprError);
    expect(err).toBeInstanceOf(Error);
    return err as ExprError;
  }
  throw new Error('expected the call to throw an ExprError');
}

function expectCode(run: () => unknown, code: string): ExprError {
  const err = errorOf(run);
  expect(err.code).toBe(code);
  expect(err.name).toBe('ExprError');
  return err;
}

const table: Record<string, number> = { d0: 3, d1: -2, d2: 0, width: 7.5, a: 2, b: 3, c: -4 };
const lookup = (name: string): number | undefined => table[name];

describe('numbers', () => {
  it('parses integers, decimals and scientific notation', () => {
    expect(evaluateSource('12', noLookup)).toBe(12);
    expect(evaluateSource('12.5', noLookup)).toBe(12.5);
    expect(evaluateSource('.5', noLookup)).toBe(0.5);
    expect(evaluateSource('1e3', noLookup)).toBe(1000);
    expect(evaluateSource('2.5E-2', noLookup)).toBe(0.025);
    expect(evaluateSource('5.', noLookup)).toBe(5);
    expect(evaluateSource('.5e2', noLookup)).toBe(50);
    expect(evaluateSource('1e+3', noLookup)).toBe(1000);
  });

  it('stops the number before an exponent marker that has no digits', () => {
    expectCode(() => parse('1e'), 'syntax');
    expectCode(() => parse('2.5e+'), 'syntax');
    expectCode(() => parse('1 e3'), 'syntax');
    expect(evaluateSource('1E3', noLookup)).toBe(1000);
  });
});

describe('operators', () => {
  it('gives * and / precedence over + and -', () => {
    expect(evaluateSource('1 + 2 * 3', noLookup)).toBe(7);
    expect(evaluateSource('2 * 3 + 4 * 5', noLookup)).toBe(26);
    expect(evaluateSource('10 - 2 * 3', noLookup)).toBe(4);
  });

  it('is left associative for + - * /', () => {
    expect(evaluateSource('8 / 4 / 2', noLookup)).toBe(1);
    expect(evaluateSource('10 - 2 - 3', noLookup)).toBe(5);
    expect(evaluateSource('2 * 3 * 4', noLookup)).toBe(24);
  });

  it('binds ^ tighter than unary minus on its left', () => {
    expect(evaluateSource('-2^2', noLookup)).toBe(-4);
    expect(evaluateSource('-2^2 + 1', noLookup)).toBe(-3);
  });

  it('is right associative for ^ and accepts a unary exponent', () => {
    expect(evaluateSource('2^3^2', noLookup)).toBe(512);
    expect(evaluateSource('2^2^3', noLookup)).toBe(256);
    expect(evaluateSource('2^-1', noLookup)).toBe(0.5);
    expect(evaluateSource('2^-2^2', noLookup)).toBe(2 ** -4);
  });

  it('handles unary plus and minus', () => {
    expect(evaluateSource('+5', noLookup)).toBe(5);
    expect(evaluateSource('- -5', noLookup)).toBe(5);
    expect(evaluateSource('2 * -3', noLookup)).toBe(-6);
    expect(evaluateSource('2 - -3', noLookup)).toBe(5);
    expect(evaluateSource('1 + + 2', noLookup)).toBe(3);
    expect(evaluateSource('1 - + 2', noLookup)).toBe(-1);
  });

  it('honours parentheses', () => {
    expect(evaluateSource('(1 + 2) * 3', noLookup)).toBe(9);
    expect(evaluateSource('1 - (2 - 3)', noLookup)).toBe(2);
    expect(evaluateSource('-(1 + 2)', noLookup)).toBe(-3);
  });

  it('exposes the operators in the AST', () => {
    expect(parse('1 + 2')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 2 },
    });
    expect(parse('-2')).toEqual({ kind: 'unary', op: '-', operand: { kind: 'number', value: 2 } });
    expect(parse('+2')).toEqual({ kind: 'unary', op: '+', operand: { kind: 'number', value: 2 } });
    expect(parse('2^-1')).toEqual({
      kind: 'binary',
      op: '^',
      left: { kind: 'number', value: 2 },
      right: { kind: 'unary', op: '-', operand: { kind: 'number', value: 1 } },
    });
  });

  it('nests * tighter than + and ^ tighter than unary minus in the AST', () => {
    expect(parse('1 + 2 * 3')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    });
    expect(parse('-2^2')).toEqual({
      kind: 'unary',
      op: '-',
      operand: {
        kind: 'binary',
        op: '^',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 2 },
      },
    });
    expect(parse('sin(30)')).toEqual({
      kind: 'call',
      fn: 'sin',
      args: [{ kind: 'number', value: 30 }],
    });
    const name = parse('d0');
    expect(name.kind).toBe('name');
    if (name.kind === 'name') {
      expect(name.name).toBe('d0');
      expect(name.start).toBe(0);
      expect(name.end).toBe(2);
    }
  });
});

describe('units', () => {
  it('converts length units by their factor', () => {
    expect(evaluateSource('10mm', noLookup)).toBeCloseTo(10 * (96 / 25.4), 10);
    expect(evaluateSource('2cm', noLookup)).toBeCloseTo(2 * 10 * (96 / 25.4), 10);
    expect(evaluateSource('(1+1)in', noLookup)).toBe(192);
    expect(evaluateSource('10 mm + 2px', noLookup)).toBeCloseTo(10 * (96 / 25.4) + 2, 10);
    expect(evaluateSource('1 px', noLookup)).toBe(1);
  });

  it('converts angle units', () => {
    expect(evaluateSource('90 deg', noLookup)).toBe(90);
    expect(evaluateSource('90\u00b0', noLookup)).toBe(90);
    expect(evaluateSource('45 \u00b0', noLookup)).toBe(45);
    expect(evaluateSource('PI rad', noLookup)).toBeCloseTo(180, 10);
    expect(evaluateSource('1 rad', noLookup)).toBeCloseTo(180 / Math.PI, 10);
  });

  it('binds a unit to the value it follows', () => {
    expect(evaluateSource('2 + 3 mm', noLookup)).toBeCloseTo(2 + 3 * (96 / 25.4), 10);
    expect(evaluateSource('2 mm * 3', noLookup)).toBeCloseTo(2 * (96 / 25.4) * 3, 10);
    expect(evaluateSource('2 ^ 3 mm', noLookup)).toBeCloseTo(2 ** (3 * (96 / 25.4)), 10);
    expect(evaluateSource('sqrt(4) mm', noLookup)).toBeCloseTo(2 * (96 / 25.4), 10);
    expect(evaluateSource('d0 mm', lookup)).toBeCloseTo(3 * (96 / 25.4), 10);
  });
});

describe('constants and functions', () => {
  it('evaluates PI and E', () => {
    expect(evaluateSource('PI', noLookup)).toBe(Math.PI);
    expect(evaluateSource('E', noLookup)).toBe(Math.E);
    expect(evaluateSource('PI * 2', noLookup)).toBeCloseTo(Math.PI * 2, 12);
  });

  it('takes degrees and returns degrees for trigonometry', () => {
    expect(evaluateSource('sin(30)', noLookup)).toBeCloseTo(0.5, 12);
    expect(evaluateSource('cos(60)', noLookup)).toBeCloseTo(0.5, 12);
    expect(evaluateSource('tan(45)', noLookup)).toBeCloseTo(1, 12);
    expect(evaluateSource('asin(0.5)', noLookup)).toBeCloseTo(30, 12);
    expect(evaluateSource('acos(0.5)', noLookup)).toBeCloseTo(60, 12);
    expect(evaluateSource('atan(1)', noLookup)).toBeCloseTo(45, 12);
    expect(evaluateSource('atan2(1, 1)', noLookup)).toBeCloseTo(45, 12);
    expect(evaluateSource('atan2(1, -1)', noLookup)).toBeCloseTo(135, 12);
    expect(evaluateSource('sin(asin(0.5))', noLookup)).toBeCloseTo(0.5, 12);
  });

  it('evaluates the remaining functions', () => {
    expect(evaluateSource('sqrt(16)', noLookup)).toBe(4);
    expect(evaluateSource('abs(-3)', noLookup)).toBe(3);
    expect(evaluateSource('floor(2.7)', noLookup)).toBe(2);
    expect(evaluateSource('ceil(2.1)', noLookup)).toBe(3);
    expect(evaluateSource('round(2.5)', noLookup)).toBe(3);
    expect(evaluateSource('sign(-2)', noLookup)).toBe(-1);
    expect(evaluateSource('sign(0)', noLookup)).toBe(0);
    expect(evaluateSource('min(3, 1, 2)', noLookup)).toBe(1);
    expect(evaluateSource('max(3, 1, 2)', noLookup)).toBe(3);
    expect(evaluateSource('min(5)', noLookup)).toBe(5);
    expect(evaluateSource('pow(2, 10)', noLookup)).toBe(1024);
    expect(evaluateSource('hypot(3, 4)', noLookup)).toBe(5);
    expect(evaluateSource('hypot(3, 4, 12)', noLookup)).toBe(13);
    expect(evaluateSource('hypot(3)', noLookup)).toBe(3);
  });

  it('allows whitespace around tokens', () => {
    expect(evaluateSource('  sin ( 30 )  +  cos ( 60 ) ', noLookup)).toBeCloseTo(1, 12);
  });

  it('is case sensitive', () => {
    expectCode(() => evaluateSource('Sin(30)', noLookup), 'unknownFunction');
    expectCode(() => evaluateSource('pi', noLookup), 'unknownName');
  });
});

describe('parse errors', () => {
  it('reports an empty expression as unexpected end', () => {
    const err = expectCode(() => parse(''), 'unexpectedEnd');
    expect(err.start).toBe(0);
    expect(err.end).toBe(0);
    expectCode(() => parse('   '), 'unexpectedEnd');
  });

  it('reports a truncated expression as unexpected end', () => {
    const err = expectCode(() => parse('1 +'), 'unexpectedEnd');
    expect(err.start).toBe(3);
    expect(err.end).toBe(3);
    expectCode(() => parse('(1'), 'unexpectedEnd');
    expectCode(() => parse('sin(1,'), 'unexpectedEnd');
    expectCode(() => parse('sin(1'), 'unexpectedEnd');
    expectCode(() => parse('-'), 'unexpectedEnd');
  });

  it('rejects trailing and stray tokens with a range', () => {
    const err = expectCode(() => parse('1 2'), 'syntax');
    expect(err.start).toBe(2);
    expect(err.end).toBe(3);
    expectCode(() => parse(')'), 'syntax');
    expectCode(() => parse('* 3'), 'syntax');
    expectCode(() => parse('(1)(2)'), 'syntax');
    expectCode(() => parse('min(1,)'), 'syntax');
    expectCode(() => parse('1..2'), 'syntax');
  });

  it('rejects unknown characters', () => {
    const err = expectCode(() => parse('1 $ 2'), 'syntax');
    expect(err.start).toBe(2);
    expect(err.end).toBe(3);
    expect(err.params.char).toBe('$');
  });

  it('rejects unknown functions and functions used as values', () => {
    const err = expectCode(() => parse('foo(1)'), 'unknownFunction');
    expect(err.params.fn).toBe('foo');
    expect(err.start).toBe(0);
    expect(err.end).toBe(3);
    expectCode(() => parse('d0(1)'), 'unknownFunction');
    expectCode(() => parse('sin'), 'unknownFunction');
    expectCode(() => parse('px'), 'unknownName');
    expectCode(() => parse('mm + 1'), 'unknownName');
  });

  it('rejects wrong arity with the call range', () => {
    for (const source of ['sin()', 'sin(1, 2)', 'sqrt()', 'round(1, 2)']) {
      const err = expectCode(() => parse(source), 'arity');
      expect(err.params.actual).toBe(source === 'sin(1, 2)' || source === 'round(1, 2)' ? 2 : 0);
    }
    const err = expectCode(() => parse('sin(1, 2)'), 'arity');
    expect(err.start).toBe(0);
    expect(err.end).toBe(9);
    expect(err.params.fn).toBe('sin');
    expect(err.params.expected).toBe('1');
    expectCode(() => parse('min()'), 'arity');
    expectCode(() => parse('pow(1)'), 'arity');
    expectCode(() => parse('pow(1, 2, 3)'), 'arity');
    expectCode(() => parse('atan2(1)'), 'arity');
    expectCode(() => parse('hypot()'), 'arity');
  });

  it('guards against pathological input', () => {
    const long = `1${'+1'.repeat(500)}`;
    expect(long.length).toBe(1001);
    expectCode(() => parse(long), 'syntax');
    expect(evaluateSource(`1${'+1'.repeat(499)}`, noLookup)).toBe(500);

    expectCode(() => parse(`${'('.repeat(101)}1${')'.repeat(101)}`), 'syntax');
    expect(evaluateSource(`${'('.repeat(100)}1${')'.repeat(100)}`, noLookup)).toBe(1);
    expectCode(() => parse(`${'-'.repeat(200)}1`), 'syntax');
    expect(evaluateSource(`${'-'.repeat(51)}1`, noLookup)).toBe(-1);
    expectCode(() => parse(`${'sin('.repeat(120)}1${')'.repeat(120)}`), 'syntax');
    expect(evaluateSource(`${'sin('.repeat(40)}1${')'.repeat(40)}`, noLookup)).toBeCloseTo(0, 12);
    expectCode(() => parse(`${'2^'.repeat(200)}2`), 'syntax');
    expect(evaluateSource(`${'2^'.repeat(3)}2`, noLookup)).toBe(2 ** (2 ** (2 ** 2)));
  });
});

describe('evaluate errors', () => {
  it('reports unknown names with the name range', () => {
    const err = expectCode(() => evaluateSource('d0 * 2', noLookup), 'unknownName');
    expect(err.params.name).toBe('d0');
    expect(err.start).toBe(0);
    expect(err.end).toBe(2);
    expect(evaluateSource('d0 * 2', lookup)).toBe(6);
    const err2 = expectCode(() => evaluate(parse('nope * 2'), noLookup), 'unknownName');
    expect(err2.params.name).toBe('nope');
  });

  it('reports division by zero', () => {
    expectCode(() => evaluateSource('1 / 0', noLookup), 'divisionByZero');
    expectCode(() => evaluateSource('1 / (2 - 2)', noLookup), 'divisionByZero');
    const err = expectCode(() => evaluateSource('1 / d2', lookup), 'divisionByZero');
    expect(err.start).toBe(4);
    expect(err.end).toBe(6);
  });

  it('reports domain errors', () => {
    expectCode(() => evaluateSource('sqrt(-1)', noLookup), 'domain');
    expectCode(() => evaluateSource('asin(2)', noLookup), 'domain');
    expectCode(() => evaluateSource('acos(-3)', noLookup), 'domain');
    const err = expectCode(
      () => evaluateSource('sqrt(d2)', (name) => (name === 'd2' ? -1 : undefined)),
      'domain',
    );
    expect(err.params.fn).toBe('sqrt');
    expect(err.start).toBe(5);
    expect(err.end).toBe(7);
  });

  it('reports non-finite results', () => {
    expectCode(() => evaluateSource('1e308 * 1e308', noLookup), 'notFinite');
    expectCode(() => evaluateSource('0 ^ -1', noLookup), 'notFinite');
    expectCode(() => evaluateSource('1e308 - -1e308', noLookup), 'notFinite');
    expectCode(() => evaluate(parse('d0'), () => NaN), 'notFinite');
    expectCode(() => evaluate(parse('d0'), () => Infinity), 'notFinite');
    expectCode(() => evaluate(parse('d0 * 2'), () => Number.NaN), 'notFinite');
    const err = expectCode(() => evaluateSource('d0 * d0', () => 1e308), 'notFinite');
    expect(err.start).toBe(0);
    expect(err.end).toBe(2);
  });

  it('checks arity and function names again when evaluating a hand-built AST', () => {
    expectCode(() => evaluate({ kind: 'call', fn: 'nope', args: [] }, noLookup), 'unknownFunction');
    expectCode(() => evaluate({ kind: 'call', fn: 'sin', args: [] }, noLookup), 'arity');
    expectCode(
      () =>
        evaluate(
          {
            kind: 'call',
            fn: 'sin',
            args: [
              { kind: 'number', value: 1 },
              { kind: 'number', value: 2 },
            ],
          },
          noLookup,
        ),
      'arity',
    );
    expect(
      evaluate({ kind: 'call', fn: 'sin', args: [{ kind: 'number', value: 30 }] }, noLookup),
    ).toBeCloseTo(0.5, 12);
  });
});

describe('full-width input', () => {
  it('normalizes full-width parentheses, operators, digits and dot', () => {
    expect(evaluateSource('（１＋２）＊３', noLookup)).toBe(9);
    expect(evaluateSource('２＾３＾２', noLookup)).toBe(512);
    expect(evaluateSource('１．５＋２．５', noLookup)).toBe(4);
    expect(evaluateSource('－２＾２', noLookup)).toBe(-4);
    expect(evaluateSource('８／４／２', noLookup)).toBe(1);
    expect(evaluateSource('１０ mm', noLookup)).toBeCloseTo(10 * (96 / 25.4), 10);
    expect(evaluateSource('（１＋１）in', noLookup)).toBe(192);
    expect(evaluateSource('min（１，２，３）', noLookup)).toBe(1);
  });

  it('keeps error ranges aligned with the original source', () => {
    const err = expectCode(() => parse('（１＋'), 'unexpectedEnd');
    expect(err.start).toBe(3);
    const err2 = expectCode(() => parse('１ ２'), 'syntax');
    expect(err2.start).toBe(2);
  });
});

describe('references', () => {
  it('collects the names an expression depends on', () => {
    expect(references(parse('d0 * 2 + d1'))).toEqual(new Set(['d0', 'd1']));
    expect(references(parse('sin(d0) + min(d1, d2)'))).toEqual(new Set(['d0', 'd1', 'd2']));
    expect(references(parse('-d0 ^ 2'))).toEqual(new Set(['d0']));
  });

  it('does not report the built-in constants', () => {
    expect(references(parse('PI * 2 + E'))).toEqual(new Set());
    expect(references(parse('sin(PI rad)'))).toEqual(new Set());
  });
});

describe('isValidName', () => {
  it('accepts identifiers that are not reserved', () => {
    expect(isValidName('d0')).toBe(true);
    expect(isValidName('width')).toBe(true);
    expect(isValidName('_hidden')).toBe(true);
    expect(isValidName('a1_b2')).toBe(true);
  });

  it('rejects reserved and malformed names', () => {
    expect(isValidName('sin')).toBe(false);
    expect(isValidName('PI')).toBe(false);
    expect(isValidName('e')).toBe(true);
    expect(isValidName('E')).toBe(false);
    expect(isValidName('mm')).toBe(false);
    expect(isValidName('in')).toBe(false);
    expect(isValidName('deg')).toBe(false);
    expect(isValidName('1x')).toBe(false);
    expect(isValidName('a-b')).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName('a b')).toBe(false);
  });
});

describe('format', () => {
  const samples = [
    '1 + 2 * 3',
    '(1 + 2) * 3',
    '2 * 3 + 4 * 5',
    '1 - (2 - 3)',
    '8 / 4 / 2',
    '10 - 2 - 3',
    '-2^2',
    '2^3^2',
    '2^-1',
    '(-5)^2',
    '(2*3)^2',
    '--1',
    '-(1 + 2)',
    '-a * b',
    '2 * -3',
    'sin(30) + cos(60)',
    'min(1, 2, 3)',
    'max(3, 4) * hypot(a, b)',
    'sqrt(a^2 + b^2)',
    'PI * 2 + E',
    'd0 * 2 + 5',
    'width / 2 - 5',
    'floor(a / b)',
    'a^2 + b^2 - c',
  ];

  it('prints canonical spacing', () => {
    expect(format(parse('d0*2+5'))).toBe('d0 * 2 + 5');
    expect(format(parse('1+2*3'))).toBe('1 + 2 * 3');
    expect(format(parse('(1+2)*3'))).toBe('(1 + 2) * 3');
    expect(format(parse('sin( 30 )'))).toBe('sin(30)');
    expect(format(parse('min(1,2,3)'))).toBe('min(1, 2, 3)');
    expect(format(parse('2^3^2'))).toBe('2 ^ 3 ^ 2');
    expect(format(parse('2^-1'))).toBe('2 ^ -1');
    expect(format(parse('-2^2'))).toBe('-(2 ^ 2)');
    expect(format(parse('(-5)^2'))).toBe('(-5) ^ 2');
    expect(format(parse('--1'))).toBe('-(-1)');
    expect(format(parse('1-(2-3)'))).toBe('1 - (2 - 3)');
    expect(format(parse('a-b-c'))).toBe('a - b - c');
    expect(format(parse('(a-b)-c'))).toBe('a - b - c');
    expect(format(parse('a-(b-c)'))).toBe('a - (b - c)');
    expect(format(parse('.5'))).toBe('0.5');
  });

  it('round-trips: parse(format(e)) evaluates the same', () => {
    for (const source of samples) {
      const ast = parse(source);
      const text = format(ast);
      expect(evaluate(parse(text), lookup)).toBe(evaluate(ast, lookup));
    }
  });

  it('round-trips expressions whose units were folded into numbers', () => {
    for (const source of ['10mm + 2px', '(1+1)in', 'PI rad', '2cm * 3', 'sqrt(4) mm']) {
      const ast = parse(source);
      expect(evaluate(parse(format(ast)), noLookup)).toBe(evaluate(ast, noLookup));
    }
  });
});

describe('resolveParams', () => {
  it('resolves an empty set', () => {
    const res = resolveParams([]);
    expect(res.values.size).toBe(0);
    expect(res.errors.size).toBe(0);
    expect(res.order).toEqual([]);
  });

  it('resolves a chain dependencies first', () => {
    const res = resolveParams([
      { name: 'a', expression: '1' },
      { name: 'b', expression: 'a + 1' },
      { name: 'c', expression: 'b * 2' },
    ]);
    expect(res.errors.size).toBe(0);
    expect(res.values.get('a')).toBe(1);
    expect(res.values.get('b')).toBe(2);
    expect(res.values.get('c')).toBe(4);
    expect(res.order).toEqual(['a', 'b', 'c']);
  });

  it('resolves a diamond', () => {
    const res = resolveParams([
      { name: 'a', expression: '1' },
      { name: 'b', expression: 'a + 1' },
      { name: 'c', expression: 'a + 2' },
      { name: 'd', expression: 'b + c' },
    ]);
    expect(res.errors.size).toBe(0);
    expect(res.values.get('d')).toBe(5);
    expect(res.order.indexOf('a')).toBeLessThan(res.order.indexOf('b'));
    expect(res.order.indexOf('b')).toBeLessThan(res.order.indexOf('d'));
    expect(res.order.indexOf('c')).toBeLessThan(res.order.indexOf('d'));
    expect(res.order.length).toBe(4);
  });

  it('resolves regardless of the order the params are declared in', () => {
    const res = resolveParams([
      { name: 'c', expression: 'b * 2' },
      { name: 'b', expression: 'a + 1' },
      { name: 'a', expression: '1' },
    ]);
    expect(res.errors.size).toBe(0);
    expect(res.values.get('c')).toBe(4);
    expect(res.order).toEqual(['a', 'b', 'c']);
  });

  it('fails dependents of a param that did not parse', () => {
    const res = resolveParams([
      { name: 'a', expression: '1 +' },
      { name: 'b', expression: 'a + 1' },
    ]);
    expect(res.errors.get('a')?.code).toBe('unexpectedEnd');
    expect(res.errors.get('b')?.code).toBe('unknownName');
    expect(res.errors.get('b')?.params.name).toBe('a');
    expect(res.values.size).toBe(0);
    expect(res.order).toEqual([]);
  });

  it('reports a self reference as a cycle', () => {
    const res = resolveParams([{ name: 'a', expression: 'a + 1' }]);
    expect(res.values.size).toBe(0);
    const err = res.errors.get('a');
    expect(err?.code).toBe('cycle');
    expect(err?.params.cycle).toBe('a \u2192 a');
    expect(res.order).toEqual([]);
  });

  it('reports every member of a three-cycle', () => {
    const res = resolveParams([
      { name: 'a', expression: 'b' },
      { name: 'b', expression: 'c' },
      { name: 'c', expression: 'a' },
    ]);
    expect(res.values.size).toBe(0);
    expect(res.order).toEqual([]);
    expect([...res.errors.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(res.errors.get('a')?.code).toBe('cycle');
    expect(res.errors.get('b')?.code).toBe('cycle');
    expect(res.errors.get('c')?.code).toBe('cycle');
    expect(res.errors.get('a')?.params.cycle).toBe('a \u2192 b \u2192 c \u2192 a');
    expect(res.errors.get('b')?.params.cycle).toBe('b \u2192 c \u2192 a \u2192 b');
    expect(res.errors.get('c')?.params.cycle).toBe('c \u2192 a \u2192 b \u2192 c');
  });

  it('fails a param that depends on a cycle member with unknownName', () => {
    const res = resolveParams([
      { name: 'a', expression: 'b' },
      { name: 'b', expression: 'a' },
      { name: 'x', expression: 'a + 1' },
    ]);
    expect(res.values.size).toBe(0);
    expect(res.errors.get('x')?.code).toBe('unknownName');
    expect(res.errors.get('x')?.params.name).toBe('a');
  });

  it('propagates evaluation failures to dependents', () => {
    const res = resolveParams([
      { name: 'a', expression: '1' },
      { name: 'b', expression: 'a / 0' },
      { name: 'c', expression: 'b + 1' },
      { name: 'd', expression: 'a + 1' },
    ]);
    expect(res.errors.get('b')?.code).toBe('divisionByZero');
    expect(res.errors.get('c')?.code).toBe('unknownName');
    expect(res.errors.get('c')?.params.name).toBe('b');
    expect(res.values.get('a')).toBe(1);
    expect(res.values.get('d')).toBe(2);
    expect(res.order).toEqual(['a', 'd']);
  });

  it('reports parse errors, unknown names and domain errors', () => {
    const res = resolveParams([
      { name: 'a', expression: '1 +' },
      { name: 'b', expression: 'nope * 2' },
      { name: 'c', expression: 'sqrt(-1)' },
      { name: 'd', expression: 'sin()' },
    ]);
    expect(res.errors.get('a')?.code).toBe('unexpectedEnd');
    const unknown = res.errors.get('b');
    expect(unknown?.code).toBe('unknownName');
    expect(unknown?.params.name).toBe('nope');
    expect(unknown?.start).toBe(0);
    expect(unknown?.end).toBe(4);
    expect(res.errors.get('c')?.code).toBe('domain');
    expect(res.errors.get('d')?.code).toBe('arity');
    expect(res.values.size).toBe(0);
  });

  it('rejects invalid and duplicate names', () => {
    const res = resolveParams([
      { name: '1x', expression: '1' },
      { name: 'sin', expression: '2' },
      { name: 'a', expression: '3' },
      { name: 'a', expression: '4' },
    ]);
    expect(res.errors.get('1x')?.code).toBe('invalidName');
    expect(res.errors.get('1x')?.params.name).toBe('1x');
    expect(res.errors.get('sin')?.code).toBe('invalidName');
    expect(res.errors.get('a')?.code).toBe('duplicateName');
    expect(res.values.get('a')).toBe(3);
    expect(res.order).toEqual(['a']);
  });

  it('uses units and functions inside parameters', () => {
    const res = resolveParams([
      { name: 'w', expression: '10 mm' },
      { name: 'h', expression: 'w / 2' },
      { name: 'diag', expression: 'hypot(w, h)' },
    ]);
    expect(res.errors.size).toBe(0);
    expect(res.values.get('h')).toBeCloseTo(5 * (96 / 25.4), 10);
    expect(res.values.get('diag')).toBeCloseTo(Math.hypot(10 * (96 / 25.4), 5 * (96 / 25.4)), 10);
  });

  it('resolves a 10 000-param chain without stack overflow', () => {
    const defs: ParamDef[] = [{ name: 'd0', expression: '1' }];
    for (let i = 1; i < 10000; i += 1) {
      defs.push({ name: `d${i}`, expression: `d${i - 1} + 1` });
    }
    const res = resolveParams(defs);
    expect(res.errors.size).toBe(0);
    expect(res.values.size).toBe(10000);
    expect(res.order.length).toBe(10000);
    expect(res.values.get('d9999')).toBe(10000);
    expect(res.order[0]).toBe('d0');
    expect(res.order[9999]).toBe('d9999');
  });

  it('resolves a wide dependency graph without stack overflow', () => {
    const defs: ParamDef[] = [{ name: 'base', expression: '10' }];
    for (let i = 0; i < 5000; i += 1) {
      defs.push({ name: `d${i}`, expression: `base + ${i}` });
    }
    const res = resolveParams(defs);
    expect(res.errors.size).toBe(0);
    expect(res.values.size).toBe(5001);
    expect(res.values.get('d4999')).toBe(5009);
    expect(res.order[0]).toBe('base');
    expect(res.order.length).toBe(5001);
  });
});

describe('findCycle', () => {
  const defs: ParamDef[] = [
    { name: 'd0', expression: '1' },
    { name: 'd1', expression: 'd0 + 1' },
  ];

  it('finds a cycle created by an edit', () => {
    expect(findCycle(defs, 'd0', 'd1 + 1')).toEqual(['d0', 'd1', 'd0']);
  });

  it('finds a self reference', () => {
    expect(findCycle(defs, 'd1', 'd1')).toEqual(['d1', 'd1']);
    expect(findCycle([], 'a', 'a')).toEqual(['a', 'a']);
  });

  it('finds a longer cycle', () => {
    const chain: ParamDef[] = [
      { name: 'a', expression: 'b + 1' },
      { name: 'b', expression: 'c + 1' },
      { name: 'c', expression: '1' },
    ];
    expect(findCycle(chain, 'c', 'a + 1')).toEqual(['c', 'a', 'b', 'c']);
  });

  it('returns undefined when no cycle is created', () => {
    expect(findCycle(defs, 'd1', 'd0 * 2')).toBeUndefined();
    expect(findCycle(defs, 'd0', '42')).toBeUndefined();
    expect(findCycle([], 'a', '1 + 2')).toBeUndefined();
    expect(findCycle(defs, 'd1', 'sin(d0)')).toBeUndefined();
  });

  it('ignores unparseable expressions and invalid names', () => {
    expect(findCycle(defs, 'd1', '1 +')).toBeUndefined();
    expect(findCycle(defs, '1x', 'a')).toBeUndefined();
    expect(findCycle(defs, 'sin', 'd0')).toBeUndefined();
  });

  it('ignores cycles that do not involve the edited param', () => {
    const cyclic: ParamDef[] = [
      { name: 'a', expression: 'b' },
      { name: 'b', expression: 'a' },
      { name: 'z', expression: '1' },
    ];
    expect(findCycle(cyclic, 'z', '2')).toBeUndefined();
  });

  it('returns undefined for a diamond', () => {
    const diamond: ParamDef[] = [
      { name: 'a', expression: '1' },
      { name: 'b', expression: 'a + 1' },
      { name: 'c', expression: 'a + 2' },
      { name: 'd', expression: 'b + c' },
    ];
    expect(findCycle(diamond, 'd', 'b + c + 1')).toBeUndefined();
    expect(findCycle(diamond, 'a', 'b')).toEqual(['a', 'b', 'a']);
  });
});
