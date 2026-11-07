import type { Constraint, Entity, Id, Value } from '../core/model';
import type { Artboard, Sketch } from '../core/sketch';

/**
 * The sketch file: a JSON document carrying the format tag, the version and the
 * sketch itself. Writing is a straight dump of the immutable sketch; reading is
 * defensive — a document is either a sketch or the reason it is not one — so a
 * truncated, corrupt or foreign file never reaches the editor.
 */

/** The format tag every sketch file carries. */
export const SKETCH_FILE_FORMAT = 'svgc-sketch';

/** The format version this module writes and accepts. */
export const SKETCH_FILE_VERSION = 1;

export type SketchFileError =
  'invalidJson' | 'unknownFormat' | 'unsupportedVersion' | 'invalidSketch';

export type SketchFileResult =
  | { readonly ok: true; readonly sketch: Sketch }
  | { readonly ok: false; readonly error: SketchFileError };

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A sketch as a JSON document: the format tag, the version and the sketch. Pretty-printed (2 spaces). */
export function serializeSketch(sketch: Sketch): string {
  return JSON.stringify(
    {
      format: SKETCH_FILE_FORMAT,
      version: SKETCH_FILE_VERSION,
      sketch: {
        entities: sketch.entities,
        constraints: sketch.constraints,
        params: sketch.params,
        // An absent section stays absent, so a file reads like the sketch it
        // came from and an empty record is never mistaken for a defined one.
        ...(sketch.expressions === undefined ? {} : { expressions: sketch.expressions }),
        ...(sketch.artboard === undefined ? {} : { artboard: sketch.artboard }),
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Parses a sketch file. Unknown EXTRA fields are ignored (forward compatibility); anything malformed is refused with a reason. */
export function parseSketch(text: string): SketchFileResult {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalidJson' };
  }
  // A document that is not an object — an array, a number, a bare string — has
  // nowhere to carry the format tag, so it is not a sketch file at all.
  if (!isRecord(document)) return { ok: false, error: 'invalidJson' };
  if (document.format !== SKETCH_FILE_FORMAT) return { ok: false, error: 'unknownFormat' };
  if (!isVersion(document.version)) return { ok: false, error: 'unsupportedVersion' };
  const sketch = readSketch(document.sketch);
  if (sketch === undefined) return { ok: false, error: 'invalidSketch' };
  return { ok: true, sketch };
}

/**
 * A version this reader accepts: a number, and no newer than the one it writes.
 * An older file is taken at face value — the sketch shape has not changed —
 * while a newer one may carry fields this build knows nothing about.
 */
function isVersion(raw: unknown): boolean {
  return typeof raw === 'number' && raw <= SKETCH_FILE_VERSION;
}

/**
 * Reads the sketch itself, keeping only the fields `Sketch` declares.
 *
 * `entities`, `constraints` and `params` are the core: a file missing one of
 * them is refused rather than defaulted, because a sketch whose parameters
 * vanished would leave every dimension that names one dangling. The optional
 * sections are read only when the file carries them.
 */
function readSketch(raw: unknown): Sketch | undefined {
  if (!isRecord(raw)) return undefined;
  const entities = readArray(raw.entities, readEntity);
  const constraints = readArray(raw.constraints, readConstraint);
  const params = readRecord(raw.params, readNumber);
  if (entities === undefined || constraints === undefined || params === undefined) return undefined;
  let expressions: Record<string, string> | undefined;
  if (raw.expressions !== undefined) {
    expressions = readRecord(raw.expressions, readText);
    if (expressions === undefined) return undefined;
  }
  let artboard: Artboard | undefined;
  if (raw.artboard !== undefined) {
    artboard = readArtboard(raw.artboard);
    if (artboard === undefined) return undefined;
  }
  return {
    entities,
    constraints,
    params,
    ...(expressions === undefined ? {} : { expressions }),
    ...(artboard === undefined ? {} : { artboard }),
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Reads one entity, keeping only the fields its kind declares: a file written
 * by a newer build that added one cannot leak it into the in-memory sketch.
 * Every kind is spelled out, so a kind added to `Entity` shows up here as a
 * missing case rather than passing through unread.
 */
function readEntity(raw: unknown): Entity | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readText(raw.id);
  if (id === undefined) return undefined;
  switch (raw.kind) {
    case 'point': {
      const x = readNumber(raw.x);
      const y = readNumber(raw.y);
      if (x === undefined || y === undefined) return undefined;
      return { kind: 'point', id, x, y };
    }
    case 'line': {
      const p1 = readText(raw.p1);
      const p2 = readText(raw.p2);
      const construction = readConstruction(raw.construction);
      if (p1 === undefined || p2 === undefined || construction === undefined) return undefined;
      return { kind: 'line', id, p1, p2, ...construction };
    }
    case 'circle': {
      const center = readText(raw.center);
      const radius = readNumber(raw.radius);
      const construction = readConstruction(raw.construction);
      if (center === undefined || radius === undefined || construction === undefined)
        return undefined;
      return { kind: 'circle', id, center, radius, ...construction };
    }
    case 'arc': {
      const center = readText(raw.center);
      const start = readText(raw.start);
      const end = readText(raw.end);
      const construction = readConstruction(raw.construction);
      if (
        center === undefined ||
        start === undefined ||
        end === undefined ||
        construction === undefined
      ) {
        return undefined;
      }
      return { kind: 'arc', id, center, start, end, ...construction };
    }
    default:
      // An unknown kind is a sketch from a newer format. Refusing it is safer
      // than dropping the entity and leaving its constraints dangling.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/** Reads one constraint, keeping only the fields its kind declares. */
function readConstraint(raw: unknown): Constraint | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readText(raw.id);
  if (id === undefined) return undefined;
  switch (raw.kind) {
    case 'coincident': {
      const both = readPair(raw.a, raw.b);
      if (both === undefined) return undefined;
      return { kind: 'coincident', id, ...both };
    }
    case 'fix': {
      const point = readText(raw.point);
      const x = readNumber(raw.x);
      const y = readNumber(raw.y);
      if (point === undefined || x === undefined || y === undefined) return undefined;
      return { kind: 'fix', id, point, x, y };
    }
    case 'horizontal': {
      const a = readText(raw.a);
      const b = readOptionalRef(raw.b);
      if (a === undefined || b === undefined) return undefined;
      return { kind: 'horizontal', id, a, ...b };
    }
    case 'vertical': {
      const a = readText(raw.a);
      const b = readOptionalRef(raw.b);
      if (a === undefined || b === undefined) return undefined;
      return { kind: 'vertical', id, a, ...b };
    }
    case 'parallel': {
      const both = readPair(raw.a, raw.b);
      if (both === undefined) return undefined;
      return { kind: 'parallel', id, ...both };
    }
    case 'perpendicular': {
      const both = readPair(raw.a, raw.b);
      if (both === undefined) return undefined;
      return { kind: 'perpendicular', id, ...both };
    }
    case 'equal': {
      const both = readPair(raw.a, raw.b);
      if (both === undefined) return undefined;
      return { kind: 'equal', id, ...both };
    }
    case 'tangent': {
      const both = readPair(raw.a, raw.b);
      if (both === undefined) return undefined;
      return { kind: 'tangent', id, ...both };
    }
    case 'pointOnLine': {
      const point = readText(raw.point);
      const line = readText(raw.line);
      if (point === undefined || line === undefined) return undefined;
      return { kind: 'pointOnLine', id, point, line };
    }
    case 'pointOnCurve': {
      const point = readText(raw.point);
      const curve = readText(raw.curve);
      if (point === undefined || curve === undefined) return undefined;
      return { kind: 'pointOnCurve', id, point, curve };
    }
    case 'midpoint': {
      const point = readText(raw.point);
      const line = readText(raw.line);
      if (point === undefined || line === undefined) return undefined;
      return { kind: 'midpoint', id, point, line };
    }
    case 'symmetric': {
      const a = readText(raw.a);
      const b = readText(raw.b);
      const line = readText(raw.line);
      if (a === undefined || b === undefined || line === undefined) return undefined;
      return { kind: 'symmetric', id, a, b, line };
    }
    case 'distance': {
      const both = readPair(raw.a, raw.b);
      const value = readValue(raw.value);
      const placement = readOptionalNumber(raw.placement);
      if (both === undefined || value === undefined || placement === undefined) return undefined;
      return { kind: 'distance', id, ...both, value, ...placement };
    }
    case 'radius': {
      const curve = readText(raw.curve);
      const value = readValue(raw.value);
      const placement = readOptionalNumber(raw.placement);
      if (curve === undefined || value === undefined || placement === undefined) return undefined;
      return { kind: 'radius', id, curve, value, ...placement };
    }
    case 'angle': {
      const both = readPair(raw.a, raw.b);
      const value = readValue(raw.value);
      const placement = readOptionalNumber(raw.placement);
      if (both === undefined || value === undefined || placement === undefined) return undefined;
      return { kind: 'angle', id, ...both, value, ...placement };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** The artboard is four finite numbers; a missing or non-numeric one refuses the file. */
function readArtboard(raw: unknown): Artboard | undefined {
  if (!isRecord(raw)) return undefined;
  const x = readNumber(raw.x);
  const y = readNumber(raw.y);
  const width = readNumber(raw.width);
  const height = readNumber(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  return { x, y, width, height };
}

/** The two operands of a constraint that relates two things. */
function readPair(a: unknown, b: unknown): { readonly a: Id; readonly b: Id } | undefined {
  const first = readText(a);
  const second = readText(b);
  if (first === undefined || second === undefined) return undefined;
  return { a: first, b: second };
}

/** The optional second operand of a horizontal/vertical over two points. */
function readOptionalRef(raw: unknown): { readonly b?: Id } | undefined {
  if (raw === undefined) return {};
  const b = readText(raw);
  if (b === undefined) return undefined;
  return { b };
}

/** The optional placement of a dimension. */
function readOptionalNumber(raw: unknown): { readonly placement?: number } | undefined {
  if (raw === undefined) return {};
  const placement = readNumber(raw);
  if (placement === undefined) return undefined;
  return { placement };
}

/** The optional construction flag of a line, circle or arc. */
function readConstruction(raw: unknown): { readonly construction?: boolean } | undefined {
  if (raw === undefined) return {};
  if (typeof raw !== 'boolean') return undefined;
  return { construction: raw };
}

/** A dimension's value: a literal number, or the name of a parameter. */
function readValue(raw: unknown): Value | undefined {
  if (typeof raw === 'string') return readText(raw);
  return readNumber(raw);
}

/** Reads an array item by item; anything that is not an array is refused. */
function readArray<T>(raw: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: T[] = [];
  for (const item of raw) {
    const value = read(item);
    if (value === undefined) return undefined;
    items.push(value);
  }
  return items;
}

/** Reads a flat record of values; anything that is not an object is refused. */
function readRecord<V>(
  raw: unknown,
  read: (value: unknown) => V | undefined,
): Record<string, V> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, V> = {};
  for (const [name, value] of Object.entries(raw)) {
    const item = read(value);
    if (item === undefined) return undefined;
    out[name] = item;
  }
  return out;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * A name: an entity id, a reference to one, the parameter a dimension value
 * names, or a parameter's source. A non-empty string, kept verbatim — an empty
 * one is refused rather than read as "no name", which would silently collide
 * with every other empty name in the sketch.
 */
function readText(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** A number the solver reads. `NaN` and the infinities are refused, never clamped. */
function readNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}
