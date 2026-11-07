import { arcParams } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Constraint, Entity, Id, Point } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';
import type { OverlayShape } from '../editor/command';
import type { InferredConstraint } from '../editor/inference';
import { artboardElements, artboardHandles } from './artboard';
import { constraintElements, constraintPlacements, hitConstraint } from './constraints';
import { constraintIcon } from '../ui/constraint-icons';
import type { ConstraintGlyph } from '../ui/constraint-icons';
import { dimensionLayout, dimensionText, isDimensionKind } from './dimensions';
import type { DimensionArrow, DimensionArc, DimensionLayout } from './dimensions';
import { pointLookup } from '../editor/hit';
import type { PointLookup } from '../editor/hit';
import type { Viewport } from '../editor/viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, String(value));
  }
  return el;
}

/** SVG path data for an arc running clockwise on screen from start to end. */
export function arcPath(center: Vec2, start: Vec2, end: Vec2): string {
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

export interface ViewState {
  readonly sketch: Sketch;
  readonly viewport: Viewport;
  readonly selection: ReadonlySet<Id>;
  /** Entities to pre-highlight (hovered entity, or the targets of a hovered constraint). */
  readonly highlight: ReadonlySet<Id>;
  /** Entities whose own geometry is fully constrained. */
  readonly constrained: ReadonlySet<Id>;
  readonly overlay: readonly OverlayShape[];
  /** Cursor in world coordinates, for hovering constraint symbols. */
  readonly cursor: Vec2 | undefined;
  /** F8/F9: draw the constraint symbols. */
  readonly showConstraints: boolean;
  /** Value text of a dimension constraint, e.g. "R40" or "120.5"; undefined draws no text. */
  readonly dimensionLabel?: (constraint: Constraint) => string | undefined;
  /** Formats a dimension's value text; the app supplies its locale's number format. */
  readonly formatNumber?: (n: number) => string;
}

/** Point radius on screen, by role. */
const POINT_PX = { endpoint: 2.5, sketchPoint: 3.5, center: 4 } as const;

/**
 * Draws the sketch in screen space. World geometry is mapped through the
 * viewport here rather than with an SVG transform, so stroke widths, point
 * sizes and the grid stay crisp at any zoom.
 */
export class SketchView {
  private readonly grid = svgElement('g', { class: 'grid', 'aria-hidden': 'true' });
  private readonly artboard = svgElement('g', { class: 'artboard', 'aria-hidden': 'true' });
  private readonly curves = svgElement('g', { class: 'curves' });
  private readonly points = svgElement('g', { class: 'points' });
  private readonly constraints = svgElement('g', { class: 'constraints' });
  private readonly overlay = svgElement('g', { class: 'overlay', 'aria-hidden': 'true' });

  constructor(readonly root: SVGSVGElement) {
    root.append(this.grid, this.artboard, this.curves, this.points, this.constraints, this.overlay);
  }

  render(state: ViewState): void {
    const { sketch, viewport: vp } = state;
    const pt = pointLookup(sketch);
    const s = (p: Vec2) => vp.toScreen(p);

    this.renderGrid(vp);
    this.artboard.replaceChildren(...artboardElements(sketch.artboard, vp));
    this.renderConstraints(state, s);

    // The overlay layer draws last, on top of the geometry, so a command's
    // operand highlight is merged into the geometry classes rather than drawn
    // over it (see `overlayElements`, which ignores 'highlight' shapes).
    const highlight = new Set<Id>([
      ...state.highlight,
      ...state.overlay.flatMap((shape) => (shape.kind === 'highlight' ? shape.ids : [])),
    ]);

    const classes = (e: Entity, base: string) => {
      const list = [base];
      if (e.kind !== 'point' && e.construction === true) list.push('construction');
      if (state.constrained.has(e.id)) list.push('constrained');
      if (highlight.has(e.id)) list.push('hover');
      if (state.selection.has(e.id)) list.push('selected');
      return list.join(' ');
    };

    this.curves.replaceChildren(
      ...sketch.entities.flatMap((e) => {
        const el = curveElement(e, pt, s, vp.scale);
        if (el === undefined) return [];
        el.setAttribute('class', classes(e, 'curve'));
        el.dataset['id'] = e.id;
        return [el];
      }),
    );

    const roles = pointRoles(sketch);
    this.points.replaceChildren(
      ...sketch.entities.flatMap((e) => {
        if (e.kind !== 'point') return [];
        const role = roles.get(e.id) ?? 'sketchPoint';
        const p = s(e);
        const el =
          role === 'center'
            ? svgElement('path', { d: crossPath(p, POINT_PX.center) })
            : svgElement('circle', { cx: p.x, cy: p.y, r: POINT_PX[role] });
        el.setAttribute('class', classes(e, `point ${role}`));
        el.dataset['id'] = e.id;
        return [el];
      }),
    );

    // A dimension being placed formats its value the way the committed one is
    // labelled; the fallback is for callers that supply no formatter.
    const format = state.formatNumber ?? ((n: number) => n.toFixed(1));
    this.overlay.replaceChildren(...state.overlay.flatMap((shape) => overlayElements(shape, sketch, s, vp.scale, vp, format)));
  }

  private renderConstraints(state: ViewState, s: (p: Vec2) => Vec2): void {
    if (!state.showConstraints) {
      this.constraints.replaceChildren();
      return;
    }
    const { sketch, viewport: vp } = state;
    // The entity index is shared by every dimension below, so it is built once
    // per render and reused; the per-constraint work is then just a lookup.
    const index = indexEntities(sketch);
    const placements = constraintPlacements(sketch, vp.scale);
    const hovered = state.cursor === undefined ? undefined : hitConstraint(placements, state.cursor, 12 / vp.scale);
    const selected = new Set([...state.selection].filter((id) => sketch.constraints.some((c) => c.id === id)));
    const constraints = new Map(sketch.constraints.map((c) => [c.id, c] as const));
    const dimensions = placements.flatMap((placement) => {
      const c = constraints.get(placement.constraint);
      // Only the three dimension kinds carry a measured value; every other
      // constraint keeps the glyph chip `constraintElements` builds below.
      if (c === undefined || !isDimensionKind(c.kind)) return [];
      const el = dimensionElement(c, index, s, vp.scale, {
        hovered: hovered === placement.constraint,
        selected: selected.has(placement.constraint),
        label: state.dimensionLabel?.(c),
      });
      return el === undefined ? [] : [el];
    });
    const symbols = constraintElements(placements, s, vp.scale, { hovered, selected });
    // Opaque glyph chips read as badges on top, so the dimension graphics go
    // underneath them; the two are spatially separated, so order is cosmetic.
    this.constraints.replaceChildren(...dimensions, ...symbols);
  }

  private renderGrid(vp: Viewport): void {
    const { minor, major } = vp.gridSteps();
    const view = vp.visibleBox();
    const lines: SVGElement[] = [];
    const add = (cls: string, x1: number, y1: number, x2: number, y2: number) =>
      lines.push(svgElement('line', { class: cls, x1, y1, x2, y2 }));
    const isMajor = (v: number) => Math.abs(v / major - Math.round(v / major)) < 1e-6;

    for (let x = Math.ceil(view.minX / minor) * minor; x <= view.maxX; x += minor) {
      const sx = Math.round(vp.toScreen({ x, y: 0 }).x) + 0.5;
      add(isMajor(x) ? 'major' : 'minor', sx, 0, sx, vp.height);
    }
    for (let y = Math.ceil(view.minY / minor) * minor; y <= view.maxY; y += minor) {
      const sy = Math.round(vp.toScreen({ x: 0, y }).y) + 0.5;
      add(isMajor(y) ? 'major' : 'minor', 0, sy, vp.width, sy);
    }
    const origin = vp.toScreen({ x: 0, y: 0 });
    add('axis x', 0, Math.round(origin.y) + 0.5, vp.width, Math.round(origin.y) + 0.5);
    add('axis y', Math.round(origin.x) + 0.5, 0, Math.round(origin.x) + 0.5, vp.height);
    lines.push(svgElement('circle', { class: 'origin', cx: origin.x, cy: origin.y, r: 3 }));
    this.grid.replaceChildren(...lines);
  }
}

/** Inferred constraint → glyph shown next to the cursor. */
const INFERRED_GLYPH: Record<InferredConstraint['kind'], ConstraintGlyph> = {
  coincident: 'coincident',
  pointOnCurve: 'pointOnCurve',
  horizontal: 'horizontal',
  vertical: 'vertical',
  parallel: 'parallel',
  perpendicular: 'perpendicular',
  tangent: 'tangent',
};
const GLYPH_PX = 16;

function overlayElements(
  shape: OverlayShape,
  sketch: Sketch,
  s: (p: Vec2) => Vec2,
  scale: number,
  vp: Viewport,
  format: (n: number) => string,
): SVGElement[] {
  switch (shape.kind) {
    case 'highlight':
      // Drawn by folding these ids into the geometry classes in `render`: the
      // overlay layer paints last, on top of the geometry it would highlight.
      return [];
    case 'selectionBox': {
      const { box } = shape;
      return [
        svgElement('rect', {
          class: `selection-box ${shape.mode}`,
          x: box.minX,
          y: box.minY,
          width: box.maxX - box.minX,
          height: box.maxY - box.minY,
        }),
      ];
    }
    case 'previewLine': {
      const a = s(shape.from);
      const b = s(shape.to);
      return [svgElement('line', { class: 'preview', x1: a.x, y1: a.y, x2: b.x, y2: b.y })];
    }
    case 'previewCircle': {
      const c = s(shape.center);
      return [svgElement('circle', { class: 'preview', cx: c.x, cy: c.y, r: shape.radius * scale })];
    }
    case 'guide': {
      const source = sketch.entities.find((e) => e.id === shape.alignment.source);
      if (source?.kind !== 'point') return [];
      const a = s(source);
      const b = s(shape.to);
      return [svgElement('line', { class: 'guide', x1: a.x, y1: a.y, x2: b.x, y2: b.y })];
    }
    case 'snap': {
      const p = s(shape.at);
      return [svgElement('circle', { class: 'snap', cx: p.x, cy: p.y, r: 5 })];
    }
    case 'inferred': {
      const p = s(shape.at);
      return shape.constraints.map((c, i) => {
        const g = svgElement('g', { class: 'inferred', transform: `translate(${p.x + 12 + i * (GLYPH_PX + 4)} ${p.y + 12})` });
        g.append(svgElement('rect', { class: 'inferred-bg', x: -2, y: -2, width: GLYPH_PX + 4, height: GLYPH_PX + 4, rx: 3 }));
        g.append(constraintIcon(INFERRED_GLYPH[c.kind], GLYPH_PX));
        return g;
      });
    }
    case 'artboardHandles':
      return artboardHandles(shape.artboard, vp);
    case 'dimension': {
      // No hover/selected/data-constraint: this is a dimension being placed,
      // not a constraint in the sketch. With no value the inline edit box
      // carries it, so the text is left off rather than drawn under the box.
      const label =
        shape.value === undefined ? undefined : dimensionText(shape.value, shape.radius === true, format);
      const g = svgElement('g', { class: 'dimension' });
      g.append(...dimensionParts(shape.layout, s, label));
      return [g];
    }
  }
}

type PointRole = 'endpoint' | 'center' | 'sketchPoint';

/** Centers draw as crosses, curve endpoints as small dots, standalone points as larger dots. */
function pointRoles(sketch: Sketch): Map<Id, PointRole> {
  const roles = new Map<Id, PointRole>();
  for (const e of sketch.entities) {
    switch (e.kind) {
      case 'line':
        roles.set(e.p1, roles.get(e.p1) ?? 'endpoint');
        roles.set(e.p2, roles.get(e.p2) ?? 'endpoint');
        break;
      case 'arc':
        roles.set(e.start, roles.get(e.start) ?? 'endpoint');
        roles.set(e.end, roles.get(e.end) ?? 'endpoint');
        roles.set(e.center, 'center');
        break;
      case 'circle':
        roles.set(e.center, 'center');
        break;
      case 'point':
        break;
    }
  }
  return roles;
}

function crossPath(p: Vec2, r: number): string {
  return `M ${p.x - r} ${p.y} H ${p.x + r} M ${p.x} ${p.y - r} V ${p.y + r}`;
}

function curveElement(
  e: Entity,
  pt: PointLookup,
  s: (p: Vec2) => Vec2,
  scale: number,
): SVGElement | undefined {
  switch (e.kind) {
    case 'point':
      return undefined;
    case 'line': {
      const a = s(pt(e.p1));
      const b = s(pt(e.p2));
      return svgElement('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    case 'circle': {
      const c = s(pt(e.center));
      return svgElement('circle', { cx: c.x, cy: c.y, r: e.radius * scale });
    }
    case 'arc': {
      const toScreen = (p: Point) => s(p);
      return svgElement('path', {
        d: arcPath(toScreen(pt(e.center)), toScreen(pt(e.start)), toScreen(pt(e.end))),
      });
    }
  }
}

/** Arrowhead length and half-width on screen, in px — a readable tick that holds up when zoomed out. */
const ARROW_LENGTH_PX = 7;
const ARROW_HALF_WIDTH_PX = 3;

/**
 * Lines, arc, arrowheads and (when given) the value text of one laid-out
 * dimension. Shared by a committed constraint and a dimension being placed, so
 * the two read identically on the canvas.
 */
function dimensionParts(layout: DimensionLayout, s: (p: Vec2) => Vec2, label?: string): SVGElement[] {
  const parts: SVGElement[] = [];
  // A radius's leader is the whole dimension, and the only layout with a single
  // line: a distance draws its dimension line first and its witness lines after
  // it, and an angle has no lines, just the arc.
  const leader = layout.lines.length === 1 ? 'dimension-leader' : undefined;
  for (let i = 0; i < layout.lines.length; i++) {
    const seg = layout.lines[i];
    if (seg === undefined) continue;
    const a = s(seg[0]);
    const b = s(seg[1]);
    parts.push(
      svgElement('line', {
        class: leader ?? (i === 0 ? 'dimension-line' : 'dimension-witness'),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      }),
    );
  }
  if (layout.arc !== undefined) parts.push(dimensionArc(layout.arc, s));
  for (const arrow of layout.arrows) parts.push(dimensionArrow(arrow, s));
  if (label !== undefined) {
    const at = s(layout.textAt);
    const text = svgElement('text', {
      class: 'dimension-text',
      x: at.x,
      y: at.y,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    });
    text.textContent = label;
    parts.push(text);
  }
  return parts;
}

/**
 * One dimension constraint's graphics: a `<g class="dimension">` carrying the
 * laid-out parts, plus the hover and selected classes the editor's picking
 * needs. Returns undefined for degenerate geometry, which the caller skips.
 */
function dimensionElement(
  c: Constraint,
  index: EntityIndex,
  s: (p: Vec2) => Vec2,
  scale: number,
  state: { readonly hovered: boolean; readonly selected: boolean; readonly label: string | undefined },
): SVGElement | undefined {
  const layout = dimensionLayout(c, index, scale);
  if (layout === undefined) return undefined;
  const g = svgElement('g', { class: 'dimension', 'data-constraint': c.id });
  if (state.hovered) g.classList.add('hover');
  if (state.selected) g.classList.add('selected');
  g.append(...dimensionParts(layout, s, state.label));
  return g;
}

/**
 * An angle dimension's arc, built with `arcPath` so the clockwise-on-screen
 * sweep flags come out right: the two endpoints are the arc's own start and
 * end angles, and everything is then mapped into screen space.
 */
function dimensionArc(arc: DimensionArc, s: (p: Vec2) => Vec2): SVGElement {
  const at = (angle: number) => ({
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  });
  return svgElement('path', {
    class: 'dimension-arc',
    d: arcPath(s(arc.center), s(at(arc.startAngle)), s(at(arc.endAngle))),
  });
}

/**
 * A filled arrowhead in screen space: a triangle with its tip at the mapped
 * point, one arrow-length deep, pointing along the layout's screen angle.
 * Drawn as a path rather than an SVG marker so it keeps the same on-screen
 * size at any zoom, like the dimension line it caps.
 */
function dimensionArrow(arrow: DimensionArrow, s: (p: Vec2) => Vec2): SVGElement {
  const tip = s(arrow.at);
  const dx = Math.cos(arrow.angle);
  const dy = Math.sin(arrow.angle);
  const bx = tip.x - ARROW_LENGTH_PX * dx;
  const by = tip.y - ARROW_LENGTH_PX * dy;
  const nx = ARROW_HALF_WIDTH_PX * dy;
  const ny = ARROW_HALF_WIDTH_PX * dx;
  return svgElement('path', {
    class: 'dimension-arrow',
    d: `M ${tip.x} ${tip.y} L ${bx - nx} ${by + ny} L ${bx + nx} ${by - ny} Z`,
  });
}
