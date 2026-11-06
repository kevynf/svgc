import { constraintRefs } from '../core/edit';
import { angleOf, arcParams, distance } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Arc, Circle, Constraint, Entity, Id, Line, Point } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';
import { constraintIcon } from '../ui/constraint-icons';
import type { ConstraintGlyph } from '../ui/constraint-icons';
import './constraints.css';

/**
 * Constraint symbols on the canvas — Inventor's 显示约束: a small glyph beside
 * the geometry each constraint acts on.
 *
 * Placement is pure geometry and takes the viewport `scale`, because every
 * offset from the geometry is given in SCREEN pixels and divided by it: a
 * symbol keeps the same distance from its geometry at any zoom, the same
 * reason `SketchView` maps world coordinates itself instead of leaning on an
 * SVG transform.
 *
 * `constraintElements` builds the SVG in screen space. `SketchView` rebuilds
 * its layers on every render, so hover and selection state is passed in per
 * call rather than mutated afterwards; the caller finds the hovered symbol
 * with `hitConstraint`, since the symbols are `pointer-events: none` and
 * picking stays in world space like the rest of the editor.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Glyph size on screen; the chip behind it adds 2px of padding per side. */
const GLYPH_PX = 16;
const CHIP_PX = GLYPH_PX + 4;

/** How far a symbol sits off the geometry it constrains, on screen. */
const OFFSET_PX = 14;
/** Where the `fix` glyph sits relative to its point, on screen (up and right). */
const FIX_PX = { x: 10, y: -10 } as const;

/**
 * Minimum on-screen distance between two symbol centers. Chips are 20px wide,
 * so this keeps them edge to edge at any zoom — the clamp that keeps a dense
 * sketch legible without swamping the drawing.
 */
const MIN_GAP_PX = 20;
/** A symbol never drifts further than this from its anchor, so nudging can't run away. */
const MAX_NUDGE_PX = 72;
/** Rings tried when nudging a symbol clear of its neighbours, in screen px. */
const NUDGE_RINGS_PX = [MIN_GAP_PX, MIN_GAP_PX + 8, MIN_GAP_PX + 20, MIN_GAP_PX + 36, MAX_NUDGE_PX];
const NUDGE_SPOKES = 8;
/** Nudge directions in screen px: straight up first, then clockwise around each ring. */
const NUDGES_PX: readonly Vec2[] = NUDGE_RINGS_PX.flatMap((r) =>
  Array.from({ length: NUDGE_SPOKES }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / NUDGE_SPOKES;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  }),
);

/** Zoomed out past this the chips would swamp the drawing, so only the glyph is drawn. */
const DENSE_SCALE = 0.3;

/** The viewport clamps its scale to [1e-3, 1e3]; this keeps a degenerate one finite. */
const MIN_SCALE = 1e-6;

export interface ConstraintPlacement {
  readonly constraint: Id;
  readonly glyph: ConstraintGlyph;
  /** World position of the symbol's center. */
  readonly at: Vec2;
  /** Entities this constraint refers to (for hover highlighting). */
  readonly refs: readonly Id[];
}

export interface ConstraintOptions {
  /** Restrict to constraints referencing these entities (Inventor's 显示约束). */
  readonly only?: ReadonlySet<Id>;
}

/** Hover and selection state for one render pass. */
export interface ConstraintSymbolState {
  readonly hovered?: Id;
  readonly selected?: ReadonlySet<Id>;
  /** Accessible name and tooltip for a symbol, e.g. `t('constraints.symbol', { kind })`. */
  readonly label?: (placement: ConstraintPlacement) => string | undefined;
}

/**
 * Where every drawable constraint's symbol goes, in world coordinates.
 * `distance`, `radius` and `angle` get no symbol yet (Phase 4 dimensions).
 */
export function constraintPlacements(
  sketch: Sketch,
  scale: number,
  options: ConstraintOptions = {},
): readonly ConstraintPlacement[] {
  const index = indexEntities(sketch);
  const only = options.only;
  const anchors: ConstraintPlacement[] = [];
  for (const c of sketch.constraints) {
    const refs = constraintRefs(c);
    if (only !== undefined && !refs.some((id) => only.has(id))) continue;
    const anchor = constraintAnchor(c, index, scale);
    if (anchor === undefined) continue;
    anchors.push({ constraint: c.id, glyph: anchor.glyph, at: anchor.at, refs });
  }
  return separate(anchors, scale);
}

/** The constraint whose symbol is under a world point, within `tolerance` world units. */
export function hitConstraint(
  placements: readonly ConstraintPlacement[],
  p: Vec2,
  tolerance: number,
): Id | undefined {
  let best: { id: Id; d: number } | undefined;
  for (const placement of placements) {
    const d = distance(placement.at, p);
    if (d > tolerance) continue;
    if (best === undefined || d < best.d) best = { id: placement.constraint, d };
  }
  return best?.id;
}

// ── Placement ───────────────────────────────────────────────────────────────

interface Anchor {
  readonly glyph: ConstraintGlyph;
  readonly at: Vec2;
}

interface Segment {
  readonly a: Vec2;
  readonly b: Vec2;
}

/** A circle or arc, flattened to what the tangency math needs. */
interface Circleish {
  readonly center: Vec2;
  readonly radius: number;
  readonly startAngle?: number;
  readonly endAngle?: number;
}

function constraintAnchor(c: Constraint, index: EntityIndex, scale: number): Anchor | undefined {
  switch (c.kind) {
    case 'coincident': {
      const p = pointAt(index, c.a) ?? pointAt(index, c.b);
      return p === undefined ? undefined : { glyph: 'coincident', at: pos(p) };
    }
    case 'fix': {
      const p = pointAt(index, c.point);
      return p === undefined ? undefined : { glyph: 'fix', at: shift(p, scale, FIX_PX.x, FIX_PX.y) };
    }
    case 'horizontal':
    case 'vertical': {
      const seg = segment(c.a, c.b, index);
      if (seg === undefined) return undefined;
      // Offset perpendicular, on the outward side of a clockwise outline.
      const n = outward(seg);
      const mid = midpoint(seg.a, seg.b);
      return { glyph: c.kind, at: shift(mid, scale, n.x * OFFSET_PX, n.y * OFFSET_PX) };
    }
    case 'parallel':
    case 'perpendicular': {
      const e = firstCurve(c.a, c.b, index);
      const at = e === undefined ? undefined : curvePoint(e, index);
      return at === undefined ? undefined : { glyph: c.kind, at };
    }
    case 'equal': {
      const e = firstCurve(c.a, c.b, index);
      if (e === undefined) return undefined;
      if (e.kind === 'line') return equalOnLine(e, index, scale);
      if (e.kind === 'circle' || e.kind === 'arc') return equalOnCurve(e, index, scale);
      return undefined;
    }
    case 'tangent': {
      const a = index.get(c.a);
      const b = index.get(c.b);
      if (a === undefined || b === undefined) return undefined;
      const at = tangency(a, b, index);
      return at === undefined ? undefined : { glyph: 'tangent', at };
    }
    case 'pointOnLine':
    case 'pointOnCurve':
    case 'midpoint': {
      const p = pointAt(index, c.point);
      return p === undefined ? undefined : { glyph: c.kind, at: pos(p) };
    }
    case 'distance':
    case 'radius':
    case 'angle':
      return undefined;
  }
}

/** Nudges symbols that land on top of each other, in screen px, keeping sketch order. */
function separate(anchors: readonly ConstraintPlacement[], scale: number): readonly ConstraintPlacement[] {
  const k = 1 / Math.max(scale, MIN_SCALE);
  const gap = MIN_GAP_PX * k;
  const taken: Vec2[] = [];
  const out: ConstraintPlacement[] = [];
  for (const anchor of anchors) {
    let at = anchor.at;
    if (taken.some((t) => distance(t, at) < gap)) {
      const nudge = NUDGES_PX.find((n) =>
        taken.every((t) => distance(t, { x: at.x + n.x * k, y: at.y + n.y * k }) >= gap),
      );
      if (nudge !== undefined) at = { x: at.x + nudge.x * k, y: at.y + nudge.y * k };
    }
    taken.push(at);
    out.push({ ...anchor, at });
  }
  return out;
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const e = index.get(id);
  return e?.kind === 'point' ? e : undefined;
}

/** A point's position as a plain vector, so placements never alias entities. */
function pos(p: Point): Vec2 {
  return { x: p.x, y: p.y };
}

/** Offsets a world point by a screen-px delta, so the offset is constant on screen at any zoom. */
function shift(p: Vec2, scale: number, dx: number, dy: number): Vec2 {
  const k = 1 / Math.max(scale, MIN_SCALE);
  return { x: p.x + dx * k, y: p.y + dy * k };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scaleVec(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

function unit(v: Vec2): Vec2 | undefined {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? undefined : { x: v.x / len, y: v.y / len };
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Closest point to `p` on the segment a–b. */
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const len2 = d.x * d.x + d.y * d.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2));
  return { x: a.x + t * d.x, y: a.y + t * d.y };
}

/**
 * Unit normal to a segment, on the outward side of a clockwise outline: above
 * a left-to-right line, right of a top-to-bottom one.
 */
function outward({ a, b }: Segment): Vec2 {
  const d = sub(b, a);
  const len = Math.hypot(d.x, d.y);
  return len === 0 ? { x: 0, y: -1 } : { x: d.y / len, y: -d.x / len };
}

/** The segment a constraint acts on: two points, or a line's own endpoints. */
function segment(a: Id, b: Id | undefined, index: EntityIndex): Segment | undefined {
  if (b !== undefined) {
    const pa = pointAt(index, a);
    const pb = pointAt(index, b);
    if (pa !== undefined && pb !== undefined) return { a: pa, b: pb };
  }
  const e = index.get(a);
  if (e?.kind !== 'line') return undefined;
  const pa = pointAt(index, e.p1);
  const pb = pointAt(index, e.p2);
  return pa === undefined || pb === undefined ? undefined : { a: pa, b: pb };
}

/** The first referenced entity that is a curve, or the first reference itself. */
function firstCurve(a: Id, b: Id, index: EntityIndex): Entity | undefined {
  const ea = index.get(a);
  if (ea !== undefined && ea.kind !== 'point') return ea;
  const eb = index.get(b);
  if (eb !== undefined && eb.kind !== 'point') return eb;
  return ea ?? eb;
}

/** Where a symbol hangs off a curve: the midpoint of a line, the top of a circle, the middle of an arc's sweep. */
function curvePoint(e: Entity, index: EntityIndex): Vec2 | undefined {
  switch (e.kind) {
    case 'point':
      return pos(e);
    case 'line': {
      const a = pointAt(index, e.p1);
      const b = pointAt(index, e.p2);
      return a === undefined || b === undefined ? undefined : midpoint(a, b);
    }
    case 'circle':
    case 'arc':
      return onCurve(e, index);
  }
}

/** Radius and mid-sweep angle of a circle or arc; a circle's sweep starts at the top. */
function frame(e: Circle | Arc, index: EntityIndex): { radius: number; mid: number } | undefined {
  const c = pointAt(index, e.center);
  if (c === undefined) return undefined;
  if (e.kind === 'circle') return e.radius === 0 ? undefined : { radius: e.radius, mid: -Math.PI / 2 };
  const start = pointAt(index, e.start) ?? c;
  const end = pointAt(index, e.end) ?? c;
  const { radius, startAngle, endAngle } = arcParams(c, start, end);
  return radius === 0 ? undefined : { radius, mid: (startAngle + endAngle) / 2 };
}

/** The point on a circle/arc at its mid-sweep angle. */
function onCurve(e: Circle | Arc, index: EntityIndex): Vec2 | undefined {
  const c = pointAt(index, e.center);
  const f = frame(e, index);
  if (c === undefined || f === undefined) return undefined;
  return { x: c.x + f.radius * Math.cos(f.mid), y: c.y + f.radius * Math.sin(f.mid) };
}

/** On the first line's midpoint, offset the other way from horizontal/vertical so the two don't collide. */
function equalOnLine(e: Line, index: EntityIndex, scale: number): Anchor | undefined {
  const seg = segment(e.id, undefined, index);
  if (seg === undefined) return undefined;
  const n = outward(seg);
  const mid = midpoint(seg.a, seg.b);
  return { glyph: 'equal', at: shift(mid, scale, -n.x * OFFSET_PX, -n.y * OFFSET_PX) };
}

/** On the first curve at mid-sweep, pushed radially outward. */
function equalOnCurve(e: Circle | Arc, index: EntityIndex, scale: number): Anchor | undefined {
  const on = onCurve(e, index);
  const f = frame(e, index);
  if (on === undefined || f === undefined) return undefined;
  return {
    glyph: 'equal',
    at: shift(on, scale, Math.cos(f.mid) * OFFSET_PX, Math.sin(f.mid) * OFFSET_PX),
  };
}

// ── Tangency ────────────────────────────────────────────────────────────────

/** Point ids a curve starts or ends at (a circle has none). */
function endpointIds(e: Entity): Id[] {
  switch (e.kind) {
    case 'point':
      return [e.id];
    case 'line':
      return [e.p1, e.p2];
    case 'circle':
      return [];
    case 'arc':
      return [e.start, e.end];
  }
}

function circleish(e: Entity, index: EntityIndex): Circleish | undefined {
  if (e.kind !== 'circle' && e.kind !== 'arc') return undefined;
  const c = pointAt(index, e.center);
  if (c === undefined) return undefined;
  if (e.kind === 'circle') return { center: c, radius: e.radius };
  const start = pointAt(index, e.start) ?? c;
  const end = pointAt(index, e.end) ?? c;
  const { radius, startAngle, endAngle } = arcParams(c, start, end);
  return { center: c, radius, startAngle, endAngle };
}

/** Whether `angle` lies on the arc sweeping clockwise on screen from `start` to `end`. */
function angleOnArc(angle: number, start: number, end: number): boolean {
  let a = angle;
  while (a < start) a += Math.PI * 2;
  while (a > start + Math.PI * 2) a -= Math.PI * 2;
  return a <= end;
}

function onCircleish(ci: Circleish, p: Vec2): boolean {
  if (ci.startAngle === undefined || ci.endAngle === undefined) return true;
  return angleOnArc(angleOf(ci.center, p), ci.startAngle, ci.endAngle);
}

/** The tangency point: the shared endpoint when the operands share one, else where they touch. */
function tangency(x: Entity, y: Entity, index: EntityIndex): Vec2 | undefined {
  const ex = endpointIds(x);
  const ey = endpointIds(y);
  for (const id of ex) {
    if (!ey.includes(id)) continue;
    const p = pointAt(index, id);
    if (p !== undefined) return pos(p);
  }
  if (x.kind === 'line' && y.kind === 'line') return lineTouch(x, y, index);
  if (x.kind === 'line' || y.kind === 'line') {
    const line = x.kind === 'line' ? x : y;
    const curve = x.kind === 'line' ? y : x;
    return lineCurveTouch(line, curve, index);
  }
  const cx = circleish(x, index);
  const cy = circleish(y, index);
  if (cx === undefined || cy === undefined) return undefined;
  const onX = circleTouch(cx, cy);
  if (onCircleish(cx, onX)) return onX;
  const onY = circleTouch(cy, cx);
  return onCircleish(cy, onY) ? onY : onX;
}

/** Not a real constraint pair; the intersection, or the midpoints when parallel. */
function lineTouch(x: Line, y: Line, index: EntityIndex): Vec2 | undefined {
  const sx = segment(x.id, undefined, index);
  const sy = segment(y.id, undefined, index);
  if (sx === undefined || sy === undefined) return undefined;
  return intersection(sx.a, sx.b, sy.a, sy.b) ?? midpoint(midpoint(sx.a, sx.b), midpoint(sy.a, sy.b));
}

function intersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | undefined {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (den === 0) return undefined;
  const t = ((p3.x - p1.x) * d2.y - (p3.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/** The foot of the perpendicular from the curve's center to the line. */
function lineCurveTouch(line: Entity, curve: Entity, index: EntityIndex): Vec2 | undefined {
  if (line.kind !== 'line') return undefined;
  const seg = segment(line.id, undefined, index);
  const ci = circleish(curve, index);
  if (seg === undefined || ci === undefined) return undefined;
  const foot = closestOnSegment(ci.center, seg.a, seg.b);
  const dir = unit(sub(foot, ci.center));
  if (dir === undefined) return undefined;
  const at = add(ci.center, scaleVec(dir, ci.radius));
  if (onCircleish(ci, at)) return at;
  // The touch point falls off the arc: use the endpoint nearest the line.
  if (curve.kind !== 'arc') return at;
  const start = pointAt(index, curve.start);
  const end = pointAt(index, curve.end);
  if (start === undefined || end === undefined) return at;
  return distance(start, foot) <= distance(end, foot) ? pos(start) : pos(end);
}

/** Where two circles touch: on the line through their centers, on the far side for internal tangency. */
function circleTouch(x: Circleish, y: Circleish): Vec2 {
  const toward = unit(sub(y.center, x.center));
  if (toward === undefined) return x.center;
  const d = distance(x.center, y.center);
  const external = Math.abs(d - x.radius - y.radius) <= Math.abs(d - Math.abs(x.radius - y.radius));
  const flip = !external && x.radius < y.radius;
  return add(x.center, scaleVec(toward, flip ? -x.radius : x.radius));
}

// ── Rendering ───────────────────────────────────────────────────────────────

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/**
 * Builds the SVG for the placements, in screen space. `s` maps world → screen
 * (the viewport's own `toScreen`) and `scale` is the viewport scale, used only
 * for the legibility clamp: zoomed far out, the chips would swamp the drawing,
 * so they are dropped and the glyph stands alone.
 */
export function constraintElements(
  placements: readonly ConstraintPlacement[],
  s: (p: Vec2) => Vec2,
  scale: number,
  state: ConstraintSymbolState = {},
): SVGElement[] {
  return placements.map((placement) => constraintSymbol(placement, s, scale, state));
}

function constraintSymbol(
  placement: ConstraintPlacement,
  s: (p: Vec2) => Vec2,
  scale: number,
  state: ConstraintSymbolState,
): SVGElement {
  const c = s(placement.at);
  const g = svgElement('g', {
    class: 'constraint-symbol',
    transform: `translate(${c.x} ${c.y})`,
    'data-constraint': placement.constraint,
  });
  if (scale < DENSE_SCALE) g.dataset['density'] = 'dense';
  if (state.hovered === placement.constraint) g.classList.add('hover');
  if (state.selected?.has(placement.constraint) === true) g.classList.add('selected');

  g.append(
    svgElement('rect', {
      class: 'constraint-chip',
      x: -CHIP_PX / 2,
      y: -CHIP_PX / 2,
      width: CHIP_PX,
      height: CHIP_PX,
      rx: 4,
    }),
  );
  const glyph = svgElement('g', { transform: `translate(${-GLYPH_PX / 2} ${-GLYPH_PX / 2})` });
  glyph.append(constraintIcon(placement.glyph, GLYPH_PX));
  g.append(glyph);

  const text = state.label?.(placement);
  if (text !== undefined) {
    g.setAttribute('role', 'img');
    g.setAttribute('aria-label', text);
    const title = svgElement('title');
    title.textContent = text;
    g.append(title);
  }
  return g;
}
