import type { Expr, ExprErrorCode, ParamDef, Resolution } from './expr';
import type { Constraint, Value } from './model';
import type { Sketch } from './sketch';
import {
  ExprError,
  evaluate,
  findCycle,
  format,
  isValidName,
  parse,
  references,
  resolveParams,
} from './expr';

/**
 * Creating, editing, renaming and deleting sketch parameters.
 *
 * A parameter lives in two places: `params` holds the number the solver reads, `expressions` the
 * source the user typed (absent for a plain value, whose source is that number). Every operation
 * validates the whole edit before it builds anything, so a refused edit answers `{ ok: false }` and
 * leaves the caller's sketch object exactly as it was.
 */

export type ParamError = ExprErrorCode | 'inUse';

export type ParamResult =
  | { readonly ok: true; readonly sketch: Sketch }
  | {
      readonly ok: false;
      readonly error: ParamError;
      readonly detail?: string;
      readonly count?: number;
    };

/**
 * Every parameter as an expression: its stored source, or `String(value)` for a plain one. `params`
 * is the parameter set — it is what the solver and the dimension constraints read — so a name only
 * found in `expressions` is not a parameter.
 */
export function paramDefs(sketch: Sketch): readonly ParamDef[] {
  const defs: ParamDef[] = [];
  for (const [name, value] of Object.entries(sketch.params)) {
    defs.push({ name, expression: sketch.expressions?.[name] ?? String(value) });
  }
  return defs;
}

/** Resolves every parameter, dependencies first ({@link resolveParams}). */
export function resolveSketchParams(sketch: Sketch): Resolution {
  return resolveParams(paramDefs(sketch));
}

/**
 * How many things break if `name` disappears: the dimensional constraints that take their value
 * from it, plus the other parameters that reference it. Zero is what {@link withoutParam} needs to
 * accept the deletion.
 */
export function paramRefCount(sketch: Sketch, name: string): number {
  let count = 0;
  for (const c of sketch.constraints) {
    if (isDimension(c) && c.value === name) count += 1;
  }
  for (const def of paramDefs(sketch)) {
    if (def.name !== name && referencesOf(def.expression).has(name)) count += 1;
  }
  return count;
}

/**
 * Adds a parameter. Refused for an invalid or duplicate name, an unparseable expression, an unknown
 * name in it, or a cycle.
 */
export function withParam(sketch: Sketch, name: string, expression: string): ParamResult {
  if (!isValidName(name)) return { ok: false, error: 'invalidName' };
  if (sketch.params[name] !== undefined) return { ok: false, error: 'duplicateName' };
  const check = checkExpression(sketch, name, expression);
  if (!check.ok) return check;
  return replaceParam(sketch, name, expression, check.value);
}

/**
 * Rewrites one parameter's expression. Every other parameter is re-resolved, so the ones that
 * reference it follow.
 */
export function withParamExpression(sketch: Sketch, name: string, expression: string): ParamResult {
  if (sketch.params[name] === undefined) return { ok: false, error: 'unknownName', detail: name };
  const check = checkExpression(sketch, name, expression);
  if (!check.ok) return check;
  return replaceParam(sketch, name, expression, check.value);
}

/**
 * Renames a parameter, rewriting the references to it in the other parameters' expressions and in
 * every dimensional constraint's value.
 */
export function withRenamedParam(sketch: Sketch, from: string, to: string): ParamResult {
  if (sketch.params[from] === undefined) return { ok: false, error: 'unknownName', detail: from };
  if (from === to) return { ok: true, sketch };
  if (!isValidName(to)) return { ok: false, error: 'invalidName' };
  if (sketch.params[to] !== undefined) return { ok: false, error: 'duplicateName' };

  const params: Record<string, number> = {};
  for (const [name, value] of Object.entries(sketch.params)) {
    params[name === from ? to : name] = value;
  }
  const sources: Record<string, string> = {};
  for (const [name, source] of Object.entries(sketch.expressions ?? {})) {
    sources[name === from ? to : name] = renamedSource(source, from, to);
  }
  const constraints = sketch.constraints.map((c): Constraint =>
    isDimension(c) && c.value === from ? { ...c, value: to } : c,
  );
  return commit(withExpressions({ ...sketch, params, constraints }, sources));
}

/** Drops a parameter. Refused with `count` while anything still references it. */
export function withoutParam(sketch: Sketch, name: string): ParamResult {
  if (sketch.params[name] === undefined) return { ok: false, error: 'unknownName', detail: name };
  const count = paramRefCount(sketch, name);
  if (count > 0) return { ok: false, error: 'inUse', count };
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(sketch.params)) {
    if (key !== name) params[key] = value;
  }
  const sources: Record<string, string> = {};
  for (const [key, source] of Object.entries(sketch.expressions ?? {})) {
    if (key !== name) sources[key] = source;
  }
  return commit(withExpressions({ ...sketch, params }, sources));
}

/** The dimensional constraints: the only ones whose value can name a parameter. */
type DimensionConstraint = Extract<Constraint, { value: Value }>;

function isDimension(c: Constraint): c is DimensionConstraint {
  return c.kind === 'distance' || c.kind === 'radius' || c.kind === 'angle';
}

/** Names a parameter source depends on; an unparseable source depends on none. */
function referencesOf(source: string): ReadonlySet<string> {
  try {
    return references(parse(source));
  } catch {
    return new Set();
  }
}

/**
 * Parses `expression` and evaluates it against the parameters other than `name`, returning the
 * value it comes to. The parameter being edited stands in for its current value (0 when it has
 * none), so that a self-reference reaches the cycle check instead of being reported as an unknown
 * name.
 */
function checkExpression(sketch: Sketch, name: string, expression: string): CheckResult {
  let ast: Expr;
  try {
    ast = parse(expression);
  } catch (err) {
    if (err instanceof ExprError) return failed(err);
    throw err;
  }
  try {
    const value = evaluate(ast, (ref) =>
      ref === name ? (sketch.params[name] ?? 0) : sketch.params[ref],
    );
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ExprError) return failed(err);
    throw err;
  }
}

/** An expression that cannot be evaluated: the reason, and the name to blame. */
type CheckResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: ParamError; readonly detail?: string };

/** Only `unknownName` names the culprit; every other code speaks for itself. */
function failed(err: ExprError): CheckResult {
  if (err.code === 'unknownName' && typeof err.params.name === 'string') {
    return { ok: false, error: err.code, detail: err.params.name };
  }
  return { ok: false, error: err.code };
}

/** Rewrites every reference to `from` as `to`, keeping the rest of the source. */
function renamedSource(source: string, from: string, to: string): string {
  let ast: Expr;
  try {
    ast = parse(source);
  } catch {
    return source;
  }
  const swap = (node: Expr): Expr => {
    switch (node.kind) {
      case 'name':
        return node.name === from ? { ...node, name: to } : node;
      case 'unary':
        return { ...node, operand: swap(node.operand) };
      case 'binary':
        return { ...node, left: swap(node.left), right: swap(node.right) };
      case 'call':
        return { ...node, args: node.args.map(swap) };
      case 'number':
        return node;
    }
  };
  return format(swap(ast));
}

/**
 * The shared tail of adding and editing a parameter: refuse the cycle, then store the source and
 * re-resolve every parameter from it.
 */
function replaceParam(
  sketch: Sketch,
  name: string,
  expression: string,
  value: number,
): ParamResult {
  if (findCycle(paramDefs(sketch), name, expression) !== undefined)
    return { ok: false, error: 'cycle' };
  const params = { ...sketch.params, [name]: value };
  const sources = { ...sketch.expressions, [name]: expression };
  return commit(withExpressions({ ...sketch, params }, sources));
}

/**
 * Stores `sources` on the sketch, dropping the field when no parameter has one: a sketch whose
 * parameters are all plain values then looks exactly like one built by hand.
 */
function withExpressions(sketch: Sketch, sources: Readonly<Record<string, string>>): Sketch {
  if (Object.keys(sources).length === 0) {
    const { expressions: _, ...rest } = sketch;
    return rest;
  }
  return { ...sketch, expressions: sources };
}

/**
 * Re-resolves every parameter of an edited sketch and stores the numbers. A parameter that no
 * longer resolves is refused: the sketch must never carry one, or the solver would have nothing to
 * read for it.
 */
function commit(next: Sketch): ParamResult {
  const defs = paramDefs(next);
  const resolution = resolveParams(defs);
  const params: Record<string, number> = {};
  for (const def of defs) {
    const value = resolution.values.get(def.name);
    if (value === undefined)
      return { ok: false, error: resolution.errors.get(def.name)?.code ?? 'unknownName' };
    params[def.name] = value;
  }
  return { ok: true, sketch: { ...next, params } };
}
