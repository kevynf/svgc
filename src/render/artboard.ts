import { handlePositions } from '../core/artboard';
import type { Artboard } from '../core/sketch';
import type { Viewport } from '../editor/viewport';
import './artboard.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Side of a resize grip, in screen px. */
const HANDLE_PX = 7;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/** Viewport rectangle minus the page, as one even-odd path so the page becomes a hole. */
function veilPath(x: number, y: number, w: number, h: number, vp: Viewport): string {
  return `M 0 0 H ${vp.width} V ${vp.height} H 0 Z M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
}

/**
 * The exported page, drawn in screen space between the grid and the geometry:
 * a subtle fill, a 1px border, a darker veil over everything outside it and a
 * muted size label above the top-left corner. The geometry stays the focus.
 */
export function artboardElements(artboard: Artboard | undefined, vp: Viewport): SVGElement[] {
  if (artboard === undefined) return [];
  const tl = vp.toScreen({ x: artboard.x, y: artboard.y });
  const br = vp.toScreen({ x: artboard.x + artboard.width, y: artboard.y + artboard.height });
  const x = tl.x;
  const y = tl.y;
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  const page = svgEl('rect', { class: 'artboard-page', x, y, width: w, height: h });
  const veil = svgEl('path', { class: 'artboard-veil', d: veilPath(x, y, w, h, vp) });
  const border = svgEl('rect', { class: 'artboard-border', x, y, width: w, height: h });
  const label = svgEl('text', { class: 'artboard-label', x, y: y - 5 });
  label.textContent = `${Math.round(artboard.width)} × ${Math.round(artboard.height)} px`;
  return [page, veil, border, label];
}

/** The eight square resize grips, drawn at constant size over the artboard. */
export function artboardHandles(artboard: Artboard, vp: Viewport): SVGElement[] {
  return Object.values(handlePositions(artboard)).map((world) => {
    const s = vp.toScreen(world);
    return svgEl('rect', {
      class: 'artboard-handle',
      x: s.x - HANDLE_PX / 2,
      y: s.y - HANDLE_PX / 2,
      width: HANDLE_PX,
      height: HANDLE_PX,
    });
  });
}
