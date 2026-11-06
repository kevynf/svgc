import { Algorithm, DebugMode, GcsWrapper, init_planegcs_module, SolveStatus } from '@salusoft89/planegcs';
import type { SketchPrimitive } from '@salusoft89/planegcs';
import type { Entity, Id } from '../core/model';
import type { Sketch } from '../core/sketch';
import { translate } from './translate';
import type { DragTarget, Translation } from './translate';

export type { DragTarget };

export type SolveOutcome = 'solved' | 'converged' | 'failed';

export interface SolveResult {
  /**
   * `converged` means the solver stopped making progress without satisfying
   * every constraint exactly, typically because of redundant constraints.
   */
  readonly outcome: SolveOutcome;
  /** The solved sketch, or the input sketch unchanged when solving failed. */
  readonly sketch: Sketch;
  /** Remaining degrees of freedom. Temporary drag constraints don't count. */
  readonly dof: number;
  readonly conflicting: readonly Id[];
  readonly redundant: readonly Id[];
  readonly partiallyRedundant: readonly Id[];
}

export class Solver {
  private disposed = false;

  constructor(private readonly gcs: GcsWrapper) {
    gcs.debug_mode = DebugMode.NoDebug;
  }

  solve(sketch: Sketch, drag?: DragTarget): SolveResult {
    if (this.disposed) {
      throw new Error('Solver has been disposed');
    }
    const translation = translate(sketch, drag);
    this.gcs.clear_data();
    this.gcs.push_primitives_and_params(translation.primitives);

    const status = this.gcs.solve(Algorithm.DogLeg);
    const outcome: SolveOutcome =
      status === SolveStatus.Success ? 'solved' : status === SolveStatus.Converged ? 'converged' : 'failed';
    const toSketchIds = (ids: string[]) => unique(ids.map((id) => translation.constraintOf.get(id)));
    const diagnostics = {
      dof: this.gcs.gcs.dof(),
      conflicting: toSketchIds(this.gcs.get_gcs_conflicting_constraints()),
      redundant: toSketchIds(this.gcs.get_gcs_redundant_constraints()),
      partiallyRedundant: toSketchIds(this.gcs.get_gcs_partially_redundant_constraints()),
    };

    if (outcome === 'failed') {
      return { outcome, sketch, ...diagnostics };
    }
    this.gcs.apply_solution();
    return { outcome, sketch: this.readBack(sketch, translation), ...diagnostics };
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.gcs.destroy_gcs_module();
    }
  }

  /**
   * Loads `sketch` into the planegcs system and runs `probe` against it. The
   * probe may push extra primitives and re-solve as often as it likes: the
   * solution is never applied to the parameters, and `solve()` clears the
   * system before loading a sketch, so probing cannot affect later solves.
   * Used by `analyzeStatus` for per-entity constraint status.
   */
  probeSystem<T>(sketch: Sketch, probe: (translation: Translation, gcs: GcsWrapper) => T): T {
    if (this.disposed) {
      throw new Error('Solver has been disposed');
    }
    const translation = translate(sketch);
    this.gcs.clear_data();
    this.gcs.push_primitives_and_params(translation.primitives);
    return probe(translation, this.gcs);
  }

  private readBack(sketch: Sketch, translation: Translation): Sketch {
    const solved = (entity: Entity): SketchPrimitive | undefined => {
      const gcsId = translation.gcsIdOf.get(entity.id);
      return gcsId === undefined ? undefined : this.gcs.sketch_index.get_primitive(gcsId);
    };
    const entities = sketch.entities.map((entity): Entity => {
      const primitive = solved(entity);
      if (entity.kind === 'point' && primitive?.type === 'point') {
        return { ...entity, x: primitive.x, y: primitive.y };
      }
      if (entity.kind === 'circle' && primitive?.type === 'circle') {
        return { ...entity, radius: primitive.radius };
      }
      return entity;
    });
    return { ...sketch, entities };
  }
}

/**
 * Loads the planegcs WebAssembly module. In the browser pass the URL of
 * `planegcs.wasm`; in Node it is resolved next to the package's JS file.
 */
export async function createSolver(wasmUrl?: string): Promise<Solver> {
  const mod = await init_planegcs_module(wasmUrl === undefined ? undefined : { locateFile: () => wasmUrl });
  return new Solver(new GcsWrapper(new mod.GcsSystem(), mod));
}

function unique(ids: (Id | undefined)[]): Id[] {
  return [...new Set(ids.filter((id): id is Id => id !== undefined))];
}
