import { SketchBuilder } from '../core/builder';
import type { Id } from '../core/model';
import type { Sketch } from '../core/sketch';

/**
 * Generators and timing harness for `analyzeStatus`. Kept out of the normal
 * test run: see `status.bench.test.ts` for how to run it.
 */

export interface Generated {
  readonly sketch: Sketch;
  /** Number of point entities, i.e. the size the timing is quoted for. */
  readonly points: number;
  /** Number of independent components, to show what the shortcuts skip. */
  readonly components: number;
}

/**
 * A grid of rectangles, each its own component, with a mix of fully
 * constrained, partly constrained and completely free cells — the shape a real
 * sketch tends to have.
 */
export function rectangleGrid(columns: number, rows: number): Generated {
  const b = new SketchBuilder();
  let points = 0;
  let components = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const p = [
        b.point(c * 120, r * 100),
        b.point(c * 120 + 60, r * 100),
        b.point(c * 120 + 60, r * 100 + 60),
        b.point(c * 120, r * 100 + 60),
      ] as const;
      const [top, right, bottom, left] = [
        b.line(p[0], p[1]),
        b.line(p[1], p[2]),
        b.line(p[2], p[3]),
        b.line(p[3], p[0]),
      ];
      b.constrain({ kind: 'horizontal', a: top });
      b.constrain({ kind: 'horizontal', a: bottom });
      b.constrain({ kind: 'vertical', a: right });
      b.constrain({ kind: 'vertical', a: left });
      b.constrain({ kind: 'distance', a: p[0], b: p[1], value: 60 });
      const kind = (c + r) % 3;
      if (kind === 0) {
        b.constrain({ kind: 'distance', a: p[1], b: p[2], value: 60 });
        b.fix(p[0]);
      } else if (kind === 1) {
        b.fix(p[0]);
      }
      points += 4;
      components++;
    }
  }
  return { sketch: b.build(), points, components };
}

/**
 * Worst case for the shortcuts if the segments between rows were constrained:
 * every point is connected. As drawn, each row's horizontal constraints form
 * their own component because the vertical segments carry no constraints, so
 * `components` counts the rows.
 */
export function polylineGrid(columns: number, rows: number): Generated {
  const b = new SketchBuilder();
  const ids: Id[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) ids.push(b.point(c * 50 + r * 3, r * 40));
  }
  const node = (r: number, c: number): Id => ids[r * columns + c]!;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      if (c + 1 < columns) b.constrain({ kind: 'horizontal', a: b.line(node(r, c), node(r, c + 1)) });
      if (r + 1 < rows) b.line(node(r, c), node(r + 1, c));
    }
  }
  b.fix(node(0, 0));
  b.fix(node(0, columns - 1));
  return { sketch: b.build(), points: ids.length, components: rows };
}

export interface Timing {
  readonly label: string;
  readonly points: number;
  readonly components: number;
  /** Median of the individual runs, in milliseconds. */
  readonly median: number;
  readonly runs: readonly number[];
}

/** Median-of-N timing of one analysis, in milliseconds. */
export function timeAnalysis(analysis: () => void, runs = 5): Timing & { median: number } {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    analysis();
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label: '',
    points: 0,
    components: 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    runs: samples,
  };
}

/** The timings to report, for a solver that has already been created. */
export function benchmark(analysis: (sketch: Sketch) => void, log?: (line: string) => void): Timing[] {
  const out: Timing[] = [];
  for (const points of [50, 100, 200, 400]) {
    for (const [name, generate] of [
      ['rectangles', rectangleGrid],
      ['polyline rows', polylineGrid],
    ] as const) {
      // 4 points per rectangle cell; the polyline grid uses `points` directly.
      const columns = 10;
      const rows = Math.max(1, Math.round(points / (name === 'rectangles' ? 4 * columns : columns)));
      const generated = generate(columns, rows);
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        analysis(generated.sketch);
        samples.push(performance.now() - started);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const timing: Timing = {
        label: name,
        points: generated.points,
        components: generated.components,
        median: sorted[2] ?? 0,
        runs: samples,
      };
      out.push(timing);
      log?.(format([timing]));
    }
  }
  return out;
}

export function format(timings: readonly Timing[]): string {
  const lines = ['points  components  generator                     median    runs'];
  for (const t of timings) {
    lines.push(
      `${String(t.points).padEnd(7)}${String(t.components).padEnd(12)}${t.label.padEnd(30)}` +
        `${t.median.toFixed(1).padStart(8)} ms  ${t.runs.map((r) => r.toFixed(1)).join(', ')}`,
    );
  }
  return lines.join('\n');
}