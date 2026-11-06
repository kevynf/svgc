import { arcParams } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Entity, Id, Point } from '../core/model';
import type { Sketch } from '../core/sketch';
import type { OverlayShape } from '../editor/command';
import type { InferredConstraint } from '../editor/inference';
import { artboardElements, artboardHandles } from './artboard';
import { constraintElements, constraintPlacements, hitConstraint } from './constraints';
import { constraintIcon } from '../ui/constraint-icons';
import type { ConstraintGlyph } from '../ui/constraint-icons';
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

    const classes = (e: Entity, base: string) => {
      const list = [base];
      if (e.kind !== 'point' && e.construction === true) list.push('construction');
      if (state.constrained.has(e.id)) list.push('constrained');
      if (state.highlight.has(e.id)) list.push('hover');
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

    this.overlay.replaceChildren(...state.overlay.flatMap((shape) => overlayElements(shape, sketch, s, vp.scale, vp)));
  }

  private renderConstraints(state: ViewState, s: (p: Vec2) => Vec2): void {
    if (!state.showConstraints) {
      this.constraints.replaceChildren();
      return;
    }
    const { sketch, viewport: vp } = state;
    const placements = constraintPlacements(sketch, vp.scale);
    const hovered = state.cursor === undefined ? undefined : hitConstraint(placements, state.cursor, 12 / vp.scale);
    this.constraints.replaceChildren(
      ...constraintElements(placements, s, vp.scale, {
        hovered,
        selected: new Set([...state.selection].filter((id) => sketch.constraints.some((c) => c.id === id))),
      }),
    );
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

function overlayElements(shape: OverlayShape, sketch: Sketch, s: (p: Vec2) => Vec2, scale: number, vp: Viewport): SVGElement[] {
  switch (shape.kind) {
    case 'highlight':
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
