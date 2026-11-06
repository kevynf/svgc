import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { Id } from './core/model';
import type { Sketch } from './core/sketch';
import { demoSketch } from './demo';
import { SketchView } from './render/view';
import { createSolver } from './solver/solver';
import type { DragTarget, SolveResult } from './solver/solver';
import './style.css';

const canvas = document.querySelector<SVGSVGElement>('#canvas');
const status = document.querySelector<HTMLElement>('#status');
if (canvas === null || status === null) {
  throw new Error('Missing #canvas or #status');
}

const solver = await createSolver(wasmUrl);
window.addEventListener('pagehide', () => solver.dispose());

const view = new SketchView(canvas);
let sketch: Sketch = demoSketch();
let dragging: Id | undefined;
let pending: DragTarget | undefined;

function apply(result: SolveResult): void {
  if (result.outcome !== 'failed') {
    sketch = result.sketch;
  }
  canvas!.classList.toggle('fully-constrained', result.dof === 0 && result.conflicting.length === 0);
  const issues = [
    result.conflicting.length > 0 ? `conflicting: ${result.conflicting.join(', ')}` : '',
    result.redundant.length > 0 ? `redundant: ${result.redundant.join(', ')}` : '',
  ].filter(Boolean);
  status!.textContent = `${result.outcome} · ${result.dof} DOF${issues.length > 0 ? ` · ${issues.join(' · ')}` : ''}`;
  view.render(sketch, dragging);
}

function toSketchCoords(event: PointerEvent): { x: number; y: number } {
  const ctm = canvas!.getScreenCTM();
  if (ctm === null) return { x: event.clientX, y: event.clientY };
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

// Coalesce pointer moves into at most one solve per frame.
function scheduleDrag(target: DragTarget): void {
  const idle = pending === undefined;
  pending = target;
  if (idle) {
    requestAnimationFrame(() => {
      if (pending !== undefined) {
        apply(solver.solve(sketch, pending));
        pending = undefined;
      }
    });
  }
}

canvas.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!(target instanceof SVGCircleElement) || !target.classList.contains('handle')) return;
  const id = target.dataset['id'];
  if (id === undefined) return;
  dragging = id;
  canvas.setPointerCapture(event.pointerId);
  view.render(sketch, dragging);
});

canvas.addEventListener('pointermove', (event) => {
  if (dragging === undefined) return;
  scheduleDrag({ point: dragging, ...toSketchCoords(event) });
});

function endDrag(): void {
  if (dragging === undefined) return;
  dragging = undefined;
  pending = undefined;
  apply(solver.solve(sketch));
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Arrow keys nudge the focused handle; Shift moves 10px.
canvas.addEventListener('keydown', (event) => {
  const target = event.target;
  if (!(target instanceof SVGCircleElement)) return;
  const id = target.dataset['id'];
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = steps[event.key];
  const point = sketch.entities.find((e) => e.id === id);
  if (step === undefined || point?.kind !== 'point') return;
  event.preventDefault();
  const scale = event.shiftKey ? 10 : 1;
  apply(solver.solve(sketch, { point: point.id, x: point.x + step[0] * scale, y: point.y + step[1] * scale }));
});

apply(solver.solve(sketch));
