/**
 * Safe parameter-expression engine for the sketch editor.
 *
 * Users type expressions into dimension edit boxes and the parameters dialog (`d0 * 2`, `width / 2
 * - 5`, `sqrt(a^2 + b^2)`). This module parses and evaluates them without `eval`, `Function` or any
 * other dynamic code execution, and resolves interdependent parameter sets.
 *
 * Grammar (whitespace is allowed between any two tokens):
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('+' | '-')* power
 *   power   := primary ('^' unary)?            // right associative
 *   primary := number unit* | name unit* | '(' expr ')' unit* | call unit*
 *   call    := name '(' [expr (',' expr)*] ')'
 *
 * Units are converted to their numeric factor while parsing (no dimensional analysis is performed),
 * so a unit suffix never appears in the AST.
 */

export type Expr =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly name: string; readonly start: number; readonly end: number }
  | { readonly kind: 'unary'; readonly op: '+' | '-'; readonly operand: Expr }
  | {
      readonly kind: 'binary';
      readonly op: '+' | '-' | '*' | '/' | '^';
      readonly left: Expr;
      readonly right: Expr;
    }
  | { readonly kind: 'call'; readonly fn: string; readonly args: readonly Expr[] };

export type ExprErrorCode =
  | 'syntax'
  | 'unexpectedEnd'
  | 'unknownName'
  | 'unknownFunction'
  | 'arity'
  | 'divisionByZero'
  | 'domain'
  | 'notFinite'
  | 'cycle'
  | 'invalidName'
  | 'duplicateName';

export class ExprError extends Error {
  override readonly name = 'ExprError';
  readonly code: ExprErrorCode;
  /** Character range in the source, when known. */
  readonly start?: number;
  readonly end?: number;
  /** Extra data for UI messages, e.g. { name: 'd3' } or { cycle: 'a → b → a' }. */
  readonly params: Readonly<Record<string, string | number>>;

  constructor(
    code: ExprErrorCode,
    message: string,
    start?: number,
    end?: number,
    params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.code = code;
    this.start = start;
    this.end = end;
    this.params = params;
  }
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/** Best-effort source range of a sub-expression: the first name it mentions. */
function rangeOf(expr: Expr): Range | undefined {
  switch (expr.kind) {
    case 'name':
      return { start: expr.start, end: expr.end };
    case 'unary':
      return rangeOf(expr.operand);
    case 'binary':
      return rangeOf(expr.left);
    case 'call':
      return expr.args.length > 0 ? rangeOf(expr.args[0]!) : undefined;
    case 'number':
      return undefined;
  }
}

/** Sources longer than this are rejected before parsing. */
const MAX_SOURCE_LENGTH = 1000;
/** Maximum nesting of parentheses, unary operators, exponents and calls. */
const MAX_DEPTH = 100;

const DEG_PER_RAD = 180 / Math.PI;

interface FnSpec {
  readonly min: number;
  readonly max: number;
  readonly apply: (args: readonly number[]) => number;
}

function unary(fn: (x: number) => number): FnSpec {
  return { min: 1, max: 1, apply: (args) => fn(args[0]!) };
}

function binaryFn(fn: (x: number, y: number) => number): FnSpec {
  return { min: 2, max: 2, apply: (args) => fn(args[0]!, args[1]!) };
}

function variadic(min: number, fn: (args: readonly number[]) => number): FnSpec {
  return { min, max: Infinity, apply: fn };
}

const degToRad = (deg: number): number => (deg * Math.PI) / 180;
const radToDeg = (rad: number): number => rad * DEG_PER_RAD;

/** Trigonometry takes degrees and returns degrees. */
const FUNCTIONS = new Map<string, FnSpec>([
  ['sin', unary((x) => Math.sin(degToRad(x)))],
  ['cos', unary((x) => Math.cos(degToRad(x)))],
  ['tan', unary((x) => Math.tan(degToRad(x)))],
  ['asin', unary((x) => radToDeg(Math.asin(x)))],
  ['acos', unary((x) => radToDeg(Math.acos(x)))],
  ['atan', unary((x) => radToDeg(Math.atan(x)))],
  ['atan2', binaryFn((y, x) => radToDeg(Math.atan2(y, x)))],
  ['sqrt', unary(Math.sqrt)],
  ['abs', unary(Math.abs)],
  ['floor', unary(Math.floor)],
  ['ceil', unary(Math.ceil)],
  ['round', unary(Math.round)],
  ['sign', unary(Math.sign)],
  ['min', variadic(1, (args) => Math.min(...args))],
  ['max', variadic(1, (args) => Math.max(...args))],
  ['pow', binaryFn(Math.pow)],
  ['hypot', variadic(1, (args) => Math.hypot(...args))],
]);

/**
 * Functions that return NaN for out-of-domain input. Every evaluated value is finite by
 * construction, so a NaN result from one of these is a domain error.
 */
const DOMAIN_CHECKED = new Set(['sqrt', 'asin', 'acos']);

/** Unit suffix -> factor applied to the number it is attached to. */
const UNIT_FACTORS = new Map<string, number>([
  ['px', 1],
  ['deg', 1],
  ['rad', DEG_PER_RAD],
  ['mm', 96 / 25.4],
  ['cm', (96 / 25.4) * 10],
  ['in', 96],
]);

const CONSTANT_NAMES = new Set(['PI', 'E']);
const RESERVED = new Set<string>([...CONSTANT_NAMES, ...FUNCTIONS.keys(), ...UNIT_FACTORS.keys()]);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function arityText(spec: FnSpec): string {
  if (spec.max === Infinity) return `at least ${spec.min}`;
  if (spec.min === spec.max) return String(spec.min);
  return `${spec.min} to ${spec.max}`;
}

// ---------------------------------------------------------------------------
// Normalization and tokenizer
// ---------------------------------------------------------------------------

/** Full-width characters commonly typed with a Chinese IME, mapped to ASCII. */
const FULLWIDTH_MAP = new Map<string, string>([
  ['（', '('],
  ['）', ')'],
  ['，', ','],
  ['＋', '+'],
  ['－', '-'],
  ['＊', '*'],
  ['／', '/'],
  ['＾', '^'],
  ['．', '.'],
]);
for (let digit = 0; digit <= 9; digit += 1) {
  FULLWIDTH_MAP.set(String.fromCharCode(0xff10 + digit), String(digit));
}
const FULLWIDTH_PATTERN = /[（），＋－＊／＾．０-９]/g;

/**
 * Replaces full-width variants with ASCII. Every replacement is one character
 * for one character, so indexes in the result match the original source.
 */
function normalizeSource(source: string): string {
  return source.replace(FULLWIDTH_PATTERN, (ch) => FULLWIDTH_MAP.get(ch) ?? ch);
}

type NameToken = {
  readonly type: 'name';
  readonly name: string;
  readonly start: number;
  readonly end: number;
};

type Token =
  | { readonly type: 'num'; readonly value: number; readonly start: number; readonly end: number }
  | NameToken
  | {
      readonly type: 'op';
      readonly op: '+' | '-' | '*' | '/' | '^';
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: 'punct';
      readonly char: '(' | ')' | ',';
      readonly start: number;
      readonly end: number;
    };

const SPACE_PATTERN = /\s/;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_');
}

function isIdentPart(ch: string | undefined): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function describeToken(token: Token): string {
  switch (token.type) {
    case 'num':
      return `number "${token.value}"`;
    case 'name':
      return `"${token.name}"`;
    case 'op':
      return `"${token.op}"`;
    case 'punct':
      return `"${token.char}"`;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (SPACE_PATTERN.test(ch)) {
      i += 1;
      continue;
    }
    // The degree sign is an alias for the `deg` unit.
    if (ch === '\u00b0') {
      tokens.push({ type: 'name', name: 'deg', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const start = i;
      while (isDigit(source[i])) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (isDigit(source[i])) i += 1;
      }
      const marker = source[i];
      if (marker === 'e' || marker === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (isDigit(source[j])) {
          i = j;
          while (isDigit(source[i])) i += 1;
        }
      }
      tokens.push({ type: 'num', value: Number(source.slice(start, i)), start, end: i });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (isIdentPart(source[i])) i += 1;
      tokens.push({ type: 'name', name: source.slice(start, i), start, end: i });
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: 'punct', char: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ type: 'op', op: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    throw new ExprError('syntax', `Unexpected character "${ch}"`, i, i + 1, { char: ch });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly tokens: readonly Token[];
  private readonly sourceEnd: number;
  private pos = 0;
  private depth = 0;

  constructor(source: string, tokens: readonly Token[]) {
    this.tokens = tokens;
    this.sourceEnd = source.length;
  }

  parse(): Expr {
    const expr = this.expression();
    const token = this.peek();
    if (token !== undefined) {
      throw new ExprError('syntax', `Unexpected ${describeToken(token)}`, token.start, token.end);
    }
    return expr;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private atPunct(char: '(' | ')' | ','): boolean {
    const token = this.peek();
    return token?.type === 'punct' && token.char === char;
  }

  private expectClose(): Token {
    const token = this.peek();
    if (token === undefined) {
      throw new ExprError('unexpectedEnd', 'Expected ")"', this.sourceEnd, this.sourceEnd);
    }
    if (token.type !== 'punct' || token.char !== ')') {
      throw new ExprError(
        'syntax',
        `Expected ")" but found ${describeToken(token)}`,
        token.start,
        token.end,
      );
    }
    this.pos += 1;
    return token;
  }

  private expression(): Expr {
    let left = this.term();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'op' && (token.op === '+' || token.op === '-')) {
        this.pos += 1;
        left = { kind: 'binary', op: token.op, left, right: this.term() };
      } else {
        return left;
      }
    }
  }

  private term(): Expr {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'op' && (token.op === '*' || token.op === '/')) {
        this.pos += 1;
        left = { kind: 'binary', op: token.op, left, right: this.unary() };
      } else {
        return left;
      }
    }
  }

  /** Counts one nesting level and rejects pathological input. */
  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      const token = this.peek();
      throw new ExprError(
        'syntax',
        'Expression nests too deeply',
        token?.start ?? this.sourceEnd,
        token?.end ?? this.sourceEnd,
      );
    }
  }

  /** Unary minus binds looser than `^` on its left: `-2^2` is `-(2^2)`. */
  private unary(): Expr {
    const token = this.peek();
    if (token?.type === 'op' && (token.op === '+' || token.op === '-')) {
      this.pos += 1;
      this.enter();
      const operand = this.unary();
      this.depth -= 1;
      return { kind: 'unary', op: token.op, operand };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.primary();
    const token = this.peek();
    if (token?.type === 'op' && token.op === '^') {
      this.pos += 1;
      this.enter();
      const exponent = this.unary();
      this.depth -= 1;
      return { kind: 'binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private primary(): Expr {
    const token = this.peek();
    if (token === undefined) {
      throw new ExprError(
        'unexpectedEnd',
        'Unexpected end of expression',
        this.sourceEnd,
        this.sourceEnd,
      );
    }
    if (token.type === 'num') {
      this.pos += 1;
      return this.applyUnits({ kind: 'number', value: token.value });
    }
    if (token.type === 'name') {
      const next = this.peek(1);
      if (next?.type === 'punct' && next.char === '(') return this.parseCall(token);
      this.pos += 1;
      if (token.name !== 'PI' && token.name !== 'E') {
        if (FUNCTIONS.has(token.name)) {
          throw new ExprError(
            'unknownFunction',
            `"${token.name}" is a function and needs an argument list`,
            token.start,
            token.end,
            { fn: token.name },
          );
        }
        if (RESERVED.has(token.name)) {
          throw new ExprError(
            'unknownName',
            `"${token.name}" is reserved and cannot be used as a value`,
            token.start,
            token.end,
            { name: token.name },
          );
        }
      }
      return this.applyUnits({
        kind: 'name',
        name: token.name,
        start: token.start,
        end: token.end,
      });
    }
    if (token.type === 'punct' && token.char === '(') {
      this.pos += 1;
      this.enter();
      const inner = this.expression();
      this.depth -= 1;
      this.expectClose();
      return this.applyUnits(inner);
    }
    throw new ExprError('syntax', `Unexpected ${describeToken(token)}`, token.start, token.end);
  }

  private parseCall(fn: NameToken): Expr {
    if (!FUNCTIONS.has(fn.name)) {
      throw new ExprError('unknownFunction', `Unknown function "${fn.name}"`, fn.start, fn.end, {
        fn: fn.name,
      });
    }
    this.pos += 2; // function name and '('
    this.enter();
    const args: Expr[] = [];
    if (!this.atPunct(')')) {
      for (;;) {
        args.push(this.expression());
        if (this.atPunct(',')) {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.depth -= 1;
    const close = this.expectClose();
    const spec = FUNCTIONS.get(fn.name)!;
    if (args.length < spec.min || args.length > spec.max) {
      throw new ExprError(
        'arity',
        `Function "${fn.name}" expects ${arityText(spec)} arguments, got ${args.length}`,
        fn.start,
        close.end,
        { fn: fn.name, expected: arityText(spec), actual: args.length },
      );
    }
    return this.applyUnits({ kind: 'call', fn: fn.name, args });
  }

  /** Consumes unit suffixes and folds their factors into the expression. */
  private applyUnits(atom: Expr): Expr {
    let result = atom;
    for (;;) {
      const token = this.peek();
      if (token?.type !== 'name') return result;
      const factor = UNIT_FACTORS.get(token.name);
      if (factor === undefined) return result;
      this.pos += 1;
      result =
        result.kind === 'number'
          ? { kind: 'number', value: result.value * factor }
          : { kind: 'binary', op: '*', left: result, right: { kind: 'number', value: factor } };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: parse
// ---------------------------------------------------------------------------

/** Parses `source` into an AST. Throws {@link ExprError} on invalid input. */
export function parse(source: string): Expr {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ExprError(
      'syntax',
      `Expression is too long (${source.length} characters)`,
      0,
      source.length,
      {
        length: source.length,
        max: MAX_SOURCE_LENGTH,
      },
    );
  }
  return new Parser(source, tokenize(normalizeSource(source))).parse();
}

// ---------------------------------------------------------------------------
// Public API: evaluate
// ---------------------------------------------------------------------------

function evalNode(expr: Expr, lookup: (name: string) => number | undefined): number {
  switch (expr.kind) {
    case 'number':
      return expr.value;
    case 'name': {
      if (expr.name === 'PI') return Math.PI;
      if (expr.name === 'E') return Math.E;
      const value = lookup(expr.name);
      if (value === undefined) {
        throw new ExprError('unknownName', `Unknown name "${expr.name}"`, expr.start, expr.end, {
          name: expr.name,
        });
      }
      if (!Number.isFinite(value)) {
        throw new ExprError(
          'notFinite',
          `Value of "${expr.name}" is not finite`,
          expr.start,
          expr.end,
          {
            name: expr.name,
          },
        );
      }
      return value;
    }
    case 'unary': {
      const value = evalNode(expr.operand, lookup);
      return finite(expr.op === '-' ? -value : value, expr);
    }
    case 'binary': {
      const left = evalNode(expr.left, lookup);
      const right = evalNode(expr.right, lookup);
      if (expr.op === '/') {
        if (right === 0) {
          throw new ExprError('divisionByZero', 'Division by zero', ...rangeSpan(expr.right));
        }
        return finite(left / right, expr);
      }
      const out =
        expr.op === '+'
          ? left + right
          : expr.op === '-'
            ? left - right
            : expr.op === '*'
              ? left * right
              : Math.pow(left, right);
      return finite(out, expr);
    }
    case 'call': {
      const spec = FUNCTIONS.get(expr.fn);
      if (spec === undefined) {
        throw new ExprError(
          'unknownFunction',
          `Unknown function "${expr.fn}"`,
          ...rangeSpan(expr),
          {
            fn: expr.fn,
          },
        );
      }
      if (expr.args.length < spec.min || expr.args.length > spec.max) {
        throw new ExprError(
          'arity',
          `Function "${expr.fn}" expects ${arityText(spec)} arguments, got ${expr.args.length}`,
          ...rangeSpan(expr),
          { fn: expr.fn, expected: arityText(spec), actual: expr.args.length },
        );
      }
      const args = expr.args.map((arg) => evalNode(arg, lookup));
      const out = spec.apply(args);
      if (DOMAIN_CHECKED.has(expr.fn) && Number.isNaN(out)) {
        const first = expr.args[0];
        throw new ExprError(
          'domain',
          `Argument of "${expr.fn}" is outside its domain`,
          ...rangeSpan(first ?? expr),
          { fn: expr.fn },
        );
      }
      return finite(out, expr);
    }
  }
}

/** Throws `notFinite` unless `value` is a finite number. */
function finite(value: number, expr: Expr): number {
  if (!Number.isFinite(value)) {
    throw new ExprError('notFinite', 'Result is not a finite number', ...rangeSpan(expr));
  }
  return value;
}

function rangeSpan(expr: Expr): [start: number | undefined, end: number | undefined] {
  const range = rangeOf(expr);
  return [range?.start, range?.end];
}

/** Evaluates a parsed expression. Throws {@link ExprError} on failure. */
export function evaluate(expr: Expr, lookup: (name: string) => number | undefined): number {
  return evalNode(expr, lookup);
}

/** Parses and evaluates `source` in one step. */
export function evaluateSource(
  source: string,
  lookup: (name: string) => number | undefined,
): number {
  return evaluate(parse(source), lookup);
}

// ---------------------------------------------------------------------------
// Public API: references
// ---------------------------------------------------------------------------

/**
 * Names the expression depends on. The built-in constants `PI` and `E` are not
 * reported: they are not parameters.
 */
export function references(expr: Expr): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: Expr): void => {
    switch (node.kind) {
      case 'name':
        if (node.name !== 'PI' && node.name !== 'E') names.add(node.name);
        break;
      case 'unary':
        visit(node.operand);
        break;
      case 'binary':
        visit(node.left);
        visit(node.right);
        break;
      case 'call':
        for (const arg of node.args) visit(arg);
        break;
      case 'number':
        break;
    }
  };
  visit(expr);
  return names;
}

// ---------------------------------------------------------------------------
// Public API: names
// ---------------------------------------------------------------------------

/** True when `name` is a syntactically valid, non-reserved parameter name. */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name) && !RESERVED.has(name);
}

// ---------------------------------------------------------------------------
// Public API: format
// ---------------------------------------------------------------------------

const PREC_ADD = 0;
const PREC_MUL = 1;
const PREC_POW = 2;
const PREC_UNARY = 3;
const PREC_ATOM = 4;

function precedence(expr: Expr): number {
  switch (expr.kind) {
    case 'binary':
      return expr.op === '^' ? PREC_POW : expr.op === '*' || expr.op === '/' ? PREC_MUL : PREC_ADD;
    case 'unary':
      return PREC_UNARY;
    default:
      return PREC_ATOM;
  }
}

/**
 * Canonical text for display: one space around binary operators, `, ` between
 * arguments, and only the parentheses needed to preserve meaning. Units are
 * folded into numbers while parsing, so they are not reproduced here.
 */
export function format(expr: Expr): string {
  const render = (node: Expr, min: number): string => {
    switch (node.kind) {
      case 'number':
        return String(node.value);
      case 'name':
        return node.name;
      case 'unary': {
        const operand = render(node.operand, PREC_UNARY);
        // Avoid `--1`; `-(-1)` reads better and parses the same.
        const text =
          operand.startsWith('-') || operand.startsWith('+')
            ? `${node.op}(${operand})`
            : node.op + operand;
        return PREC_UNARY < min ? `(${text})` : text;
      }
      case 'binary': {
        const prec = precedence(node);
        // `^` is right associative: its left side needs a tighter binding.
        const leftMin = node.op === '^' ? PREC_ATOM : prec;
        const rightMin = node.op === '^' ? prec : prec + 1;
        const text = `${render(node.left, leftMin)} ${node.op} ${render(node.right, rightMin)}`;
        return prec < min ? `(${text})` : text;
      }
      case 'call':
        return `${node.fn}(${node.args.map((arg) => render(arg, PREC_ADD)).join(', ')})`;
    }
  };
  return render(expr, PREC_ADD);
}

// ---------------------------------------------------------------------------
// Public API: parameter resolution
// ---------------------------------------------------------------------------

export interface ParamDef {
  readonly name: string;
  readonly expression: string;
}

export interface Resolution {
  readonly values: ReadonlyMap<string, number>;
  /**
   * Params that could not be evaluated, with the reason. Params depending on a
   * failed param fail with 'unknownName' or their own error.
   */
  readonly errors: ReadonlyMap<string, ExprError>;
  /** Evaluation order (dependencies first) of the successfully resolved params. */
  readonly order: readonly string[];
}

/**
 * Finds every parameter that takes part in a dependency cycle. Returns the
 * cycle path (rotated so it starts at the param) for each of them.
 */
function findCycles(deps: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string> {
  const paths = new Map<string, string>();
  const color = new Map<string, number>(); // absent = unvisited, 1 = on stack, 2 = done
  for (const root of deps.keys()) {
    if ((color.get(root) ?? 0) !== 0) continue;
    const stack: { readonly name: string; readonly deps: readonly string[]; index: number }[] = [];
    const path: string[] = [];
    const enter = (name: string): void => {
      color.set(name, 1);
      path.push(name);
      const edges = deps.get(name);
      stack.push({ name, deps: edges === undefined ? [] : [...edges], index: 0 });
    };
    enter(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.deps.length) {
        color.set(frame.name, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const next = frame.deps[frame.index]!;
      frame.index += 1;
      const state = color.get(next) ?? 0;
      if (state === 0) {
        if (deps.has(next)) enter(next);
        continue;
      }
      if (state === 1) {
        // Back edge: the cycle is the stack slice from `next` to here.
        const at = path.indexOf(next);
        if (at >= 0) {
          const cycle = path.slice(at);
          for (let i = 0; i < cycle.length; i += 1) {
            const node = cycle[i]!;
            if (paths.has(node)) continue;
            paths.set(node, [...cycle.slice(i), ...cycle.slice(0, i), node].join(' \u2192 '));
          }
        }
      }
    }
  }
  return paths;
}

/** Dependency edges of one parameter set, restricted to names in the set. */
function dependenciesOf(sources: ReadonlyMap<string, string>): Map<string, ReadonlySet<string>> {
  const deps = new Map<string, ReadonlySet<string>>();
  for (const [name, source] of sources) {
    let ast: Expr;
    try {
      ast = parse(source);
    } catch {
      deps.set(name, new Set());
      continue;
    }
    const edges = new Set<string>();
    for (const ref of references(ast)) if (sources.has(ref)) edges.add(ref);
    deps.set(name, edges);
  }
  return deps;
}

/**
 * Resolves a set of interdependent parameters. Cycles, invalid names and
 * duplicates are reported; everything else is evaluated dependencies first.
 * Runs in O(n + edges) with iterative traversals only.
 */
export function resolveParams(defs: readonly ParamDef[]): Resolution {
  const values = new Map<string, number>();
  const errors = new Map<string, ExprError>();

  // 1. Names: invalid ones are rejected, the first definition of a name wins.
  const sources = new Map<string, string>();
  for (const def of defs) {
    if (!isValidName(def.name)) {
      if (!errors.has(def.name)) {
        errors.set(
          def.name,
          new ExprError(
            'invalidName',
            `"${def.name}" is not a valid parameter name`,
            undefined,
            undefined,
            { name: def.name },
          ),
        );
      }
      continue;
    }
    if (sources.has(def.name)) {
      errors.set(
        def.name,
        new ExprError(
          'duplicateName',
          `Duplicate parameter name "${def.name}"`,
          undefined,
          undefined,
          { name: def.name },
        ),
      );
      continue;
    }
    sources.set(def.name, def.expression);
  }

  // 2. Parse every expression, remembering failures.
  const asts = new Map<string, Expr>();
  for (const [name, source] of sources) {
    try {
      asts.set(name, parse(source));
    } catch (err) {
      if (err instanceof ExprError) errors.set(name, err);
      else throw err;
    }
  }

  // 3. Dependency graph over the parameters themselves.
  const deps = new Map<string, ReadonlySet<string>>();
  for (const name of sources.keys()) {
    const ast = asts.get(name);
    const edges = new Set<string>();
    if (ast !== undefined) {
      for (const ref of references(ast)) if (sources.has(ref)) edges.add(ref);
    }
    deps.set(name, edges);
  }

  // 4. Cycles: every member of a cycle fails, with its own path.
  const cycles = findCycles(deps);
  for (const [name, path] of cycles) {
    errors.set(
      name,
      new ExprError('cycle', `Parameter cycle: ${path}`, undefined, undefined, { cycle: path }),
    );
  }

  // 5. Kahn's algorithm over the parameters that are not in a cycle.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [name, edges] of deps) {
    if (cycles.has(name)) continue;
    indegree.set(name, edges.size);
    for (const edge of edges) {
      const list = dependents.get(edge);
      if (list === undefined) dependents.set(edge, [name]);
      else list.push(name);
    }
  }
  const queue: string[] = [];
  for (const name of sources.keys()) {
    if (indegree.get(name) === 0) queue.push(name);
  }

  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const name = queue[head]!;
    head += 1;
    const ast = asts.get(name);
    if (ast !== undefined) {
      try {
        values.set(
          name,
          evaluate(ast, (ref) => values.get(ref)),
        );
        order.push(name);
      } catch (err) {
        if (err instanceof ExprError) errors.set(name, err);
        else throw err;
      }
    }
    for (const dependent of dependents.get(name) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  // 6. Whatever is left depends (transitively) on a cycle member.
  for (const name of sources.keys()) {
    if (values.has(name) || errors.has(name)) continue;
    let missing: string | undefined;
    for (const edge of deps.get(name) ?? []) {
      if (!values.has(edge)) {
        missing = edge;
        break;
      }
    }
    errors.set(
      name,
      new ExprError(
        'unknownName',
        `Cannot resolve "${name}": "${missing ?? name}" has no value`,
        undefined,
        undefined,
        {
          name: missing ?? name,
        },
      ),
    );
  }

  return { values, errors, order };
}

/**
 * Would setting `name` to `expression` create a cycle? Returns the cycle path
 * (e.g. `['d1', 'd0', 'd1']`) or undefined. Used to reject an edit before
 * applying it.
 */
export function findCycle(
  defs: readonly ParamDef[],
  name: string,
  expression: string,
): string[] | undefined {
  if (!isValidName(name)) return undefined;
  const sources = new Map<string, string>();
  for (const def of defs) {
    if (isValidName(def.name) && !sources.has(def.name)) sources.set(def.name, def.expression);
  }
  sources.set(name, expression);

  const deps = dependenciesOf(sources);
  const seen = new Set<string>([name]);
  const stack: { readonly edges: readonly string[]; index: number }[] = [];
  const path: string[] = [name];
  const enter = (node: string): void => {
    const edges = deps.get(node);
    stack.push({ edges: edges === undefined ? [] : [...edges], index: 0 });
  };
  enter(name);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.edges.length) {
      stack.pop();
      path.pop();
      continue;
    }
    const next = frame.edges[frame.index]!;
    frame.index += 1;
    if (next === name) return [...path, name];
    if (seen.has(next)) continue;
    seen.add(next);
    path.push(next);
    enter(next);
  }
  return undefined;
}
