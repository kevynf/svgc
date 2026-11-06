import { arcParams } from '../core/geometry';
import type { Entity, Id, Point } from '../core/model';
import type { Sketch } from '../core/sketch';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  return el;
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, String(value));
  }
}

/** SVG path data for an arc running clockwise on screen from start to end. */
export function arcPath(center: Point, start: Point, end: Point): string {
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

/**
 * Renders sketch geometry into two layers: curves below, point handles above.
 * Curves are rebuilt on every call; handles are keyed by id so keyboard focus
 * survives re-renders.
 */
export class SketchView {
  private readonly curves = svgElement('g', { class: 'curves' });
  private readonly handles = svgElement('g', { class: 'handles' });
  private readonly handleById = new Map<Id, SVGCircleElement>();

  constructor(root: SVGSVGElement) {
    root.append(this.curves, this.handles);
  }

  render(sketch: Sketch, activePoint?: Id): void {
    const points = new Map<Id, Point>();
    for (const e of sketch.entities) {
      if (e.kind === 'point') points.set(e.id, e);
    }
    const pt = (id: Id): Point => {
      const p = points.get(id);
      if (p === undefined) throw new Error(`Unknown point "${id}"`);
      return p;
    };

    this.curves.replaceChildren(
      ...sketch.entities.flatMap((e) => {
        const el = this.curve(e, pt);
        return el === undefined ? [] : [el];
      }),
    );

    for (const [id, el] of this.handleById) {
      if (!points.has(id)) {
        el.remove();
        this.handleById.delete(id);
      }
    }
    for (const p of points.values()) {
      let el = this.handleById.get(p.id);
      if (el === undefined) {
        el = svgElement('circle', { 'data-id': p.id, r: 4, tabindex: 0, role: 'button' });
        this.handleById.set(p.id, el);
        this.handles.append(el);
      }
      setAttrs(el, {
        class: p.id === activePoint ? 'handle active' : 'handle',
        cx: p.x,
        cy: p.y,
        'aria-label': `Point ${p.id} at ${Math.round(p.x)}, ${Math.round(p.y)}`,
      });
    }
  }

  private curve(e: Entity, pt: (id: Id) => Point): SVGElement | undefined {
    const cls = e.kind !== 'point' && e.construction ? 'curve construction' : 'curve';
    switch (e.kind) {
      case 'point':
        return undefined;
      case 'line': {
        const [a, b] = [pt(e.p1), pt(e.p2)];
        return svgElement('line', { class: cls, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      case 'circle': {
        const c = pt(e.center);
        return svgElement('circle', { class: cls, cx: c.x, cy: c.y, r: e.radius });
      }
      case 'arc':
        return svgElement('path', { class: cls, d: arcPath(pt(e.center), pt(e.start), pt(e.end)) });
    }
  }
}
