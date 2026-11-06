import { Algorithm, SolveStatus } from '@salusoft89/planegcs';
import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs';
import { constraintRefs, definingPoints } from '../core/edit';
import type { Entity, Id } from '../core/model';
import type { Constraint } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { Sketch } from '../core/sketch';
import type { Solver } from './solver';
import type { Translation } from './translate';

/**
 * Per-entity constraint status, the way Inventor colours a sketch: an entity
 * is "fully constrained" when nothing about it can still move.
 *
 * ## Approach: probing
 *
 * planegcs only reports a *global* degree-of-freedom count, so per-entity
 * status has to be derived. We probe: for every point we push a
 * `coordinate_x` / `coordinate_y` constraint pinning it at its current
 * position and watch the DOF.
 *
 * - DOF unchanged → the pin is linearly dependent on the existing equations,
 *   so that coordinate is already determined.
 * - DOF down by one → the pin carries new information, so the coordinate is
 *   free.
 *
 * x and y are probed separately (a point on a horizontal line has y
 * determined but x free) and a circle's radius is probed with a
 * `circle_radius` constraint. `fix` lowers to two coordinate constraints that
 * share one sketch constraint id, so probing needs constraint ids of its own:
 * `Solver.probeSystem` hands us the lowered translation plus the live wrapper.
 *
 * Probing never applies the solution, so the parameters stay at the pushed
 * (input) coordinates and every probe is exactly satisfied. That is not a
 * detail: applying the solution leaves ~1e-9 of noise, and on a nearly
 * degenerate sketch that noise is enough to flip planegcs' QR rank decision.
 *
 * ## Why not one batch of all pins
 *
 * Pushing every candidate pin at once and reading the redundant list does
 * **not** work. planegcs identifies dependent constraints with a pivoted QR,
 * so with several redundant rows it reports an order-dependent and incomplete
 * subset — and redundancy *between the pins themselves* is not redundancy with
 * respect to the sketch. Two points held at a fixed distance from each other
 * but otherwise free are the counter-example: neither point is determined, yet
 * pinning all four coordinates makes one pin redundant relative to the others.
 *
 * ## Making probing affordable
 *
 * One solve per candidate is too slow, because every solve re-runs a full QR
 * diagnosis whose cost grows with the whole system. Four shortcuts keep it
 * cheap without giving up correctness:
 *
 * 1. **Independent components.** Entities are split into groups linked by
 *    constraints (plus the points those constraints need). Groups share no
 *    equations, so a group's status depends only on itself and each is solved
 *    on its own instead of dragging the whole sketch along. Geometry that no
 *    constraint refers to contributes neither equations nor parameters, so it
 *    is left out of the groups entirely and its status is derived from its
 *    points — which is also what keeps a row of a polyline grid from being
 *    glued to the next one by an unconstrained connecting segment.
 *    The global DOF is the sum of the group DOFs, so the "DOF is zero"
 *    shortcut is applied per group — equivalent, and it avoids a full-system
 *    solve just to discover that.
 * 2. **Ungrounded groups.** Every constraint kind except `fix` is invariant
 *    under translating an entire group, so a group without a `fix` can never
 *    have a determined coordinate and needs no probing at all.
 * 3. **Group testing.** A batch of pins is entirely determined when it leaves
 *    the DOF unchanged (every pin then lies in the span of the existing
 *    equations) and entirely free when it lowers the DOF by exactly the batch
 *    size (no pin lies in that span). Both tests are exact, so a batch that
 *    comes back "mixed" is simply halved. They are sound because all pins
 *    constrain distinct parameters and are therefore mutually independent —
 *    nothing is assumed about redundancy *between* pins.
 * 4. **Pairing.** A point's two coordinates are probed together first, so a
 *    point whose x and y share a fate — the common case — costs one solve
 *    instead of two.
 */
export type EntityStatus = 'fully' | 'under';

export interface StatusReport {
  /** Status of every entity in the sketch. */
  readonly entities: ReadonlyMap<Id, EntityStatus>;
  /** Time spent analysing, in milliseconds. */
  readonly millis: number;
}

/** One coordinate whose determinedness is unknown, plus where its answer goes. */
interface Probe {
  readonly entity: Id;
  readonly determined: { value: boolean };
  readonly constraint: (id: string) => SketchPrimitive;
}

/** Entities linked by constraints; independent of the other components. */
interface Component {
  readonly entities: readonly Entity[];
  readonly constraints: readonly Constraint[];
  /** Contains a `fix`, i.e. something that breaks translational freedom. */
  readonly grounded: boolean;
}

interface Loaded {
  readonly translation: Translation;
  readonly gcs: GcsWrapper;
  readonly dof: number;
}

/**
 * Upper bound on how many probes go into one planegcs solve. Bigger batches
 * make the QR diagnosis planegcs runs per solve allocate a proportionally
 * bigger Jacobian, and a batch can only ever be resolved as a whole, so there
 * is nothing to gain from going large.
 */
const MAX_BATCH = 128;

/** Below this many probes the recursion switches to probing one point at a time. */
const LEAF = 32;

export function analyzeStatus(solver: Solver, sketch: Sketch): StatusReport {
  const started = performance.now();
  const statuses = new Map<Id, EntityStatus>();
  const report = (): StatusReport => ({ entities: statuses, millis: performance.now() - started });
  if (sketch.entities.length === 0) {
    return report();
  }

  const { components, derived } = componentsOf(sketch);
  // First pass: load each component once. A conflict anywhere means the whole
  // sketch is reported as under-constrained (the UI shows conflicts
  // separately), and a component with no DOF left needs no probing.
  const pending: Component[] = [];
  for (const component of components) {
    if (!component.grounded) {
      for (const entity of component.entities) statuses.set(entity.id, 'under');
      continue;
    }
    const loaded = load(solver, sketch, component);
    if (loaded === undefined || loaded.gcs.get_gcs_conflicting_constraints().length > 0) {
      for (const entity of sketch.entities) statuses.set(entity.id, 'under');
      return report();
    }
    if (loaded.dof === 0) {
      for (const entity of component.entities) statuses.set(entity.id, 'fully');
      continue;
    }
    pending.push(component);
  }

  // Second pass: probe the components that still have degrees of freedom.
  for (const component of pending) {
    const loaded = load(solver, sketch, component);
    if (loaded === undefined) {
      for (const entity of component.entities) statuses.set(entity.id, 'under');
      continue;
    }
    const { translation, gcs, dof } = loaded;
    const probes = probesOf(component, translation);
    resolve(gcs, translation.primitives, dof, probes);
    const settled = settle(probes);
    for (const entity of component.entities) {
      statuses.set(entity.id, entityStatus(entity, settled));
    }
  }
  // Unconstrained geometry: its points carry the whole answer, and a circle's
  // radius is free by definition.
  for (const entity of derived) {
    statuses.set(entity.id, derivedStatus(entity, statuses));
  }
  return report();
}

/** Loads one component into the solver and solves it; `undefined` on failure. */
function load(solver: Solver, sketch: Sketch, component: Component): Loaded | undefined {
  const sub: Sketch = { entities: component.entities, constraints: component.constraints, params: sketch.params };
  return solver.probeSystem(sub, (translation, gcs) => {
    const status = gcs.solve(Algorithm.DogLeg);
    if (status !== SolveStatus.Success && status !== SolveStatus.Converged) {
      return undefined;
    }
    return { translation, gcs, dof: gcs.gcs.dof() };
  });
}

/**
 * The coordinates to probe for a component: each point's x and y next to each
 * other, then the radius of each circle. Keeping a point's two coordinates
 * adjacent matters: a point whose coordinates share a fate (the common case)
 * is then settled by a single solve instead of two.
 */
function probesOf(component: Component, translation: Translation): Probe[] {
  const probes: Probe[] = [];
  for (const entity of component.entities) {
    if (entity.kind === 'point') {
      const p_id = translation.gcsIdOf.get(entity.id);
      if (p_id === undefined) continue;
      probes.push({
        entity: entity.id,
        determined: { value: false },
        constraint: (id) => ({ id, type: 'coordinate_x', p_id, x: entity.x }),
      });
      probes.push({
        entity: entity.id,
        determined: { value: false },
        constraint: (id) => ({ id, type: 'coordinate_y', p_id, y: entity.y }),
      });
    } else if (entity.kind === 'circle') {
      const c_id = translation.gcsIdOf.get(entity.id);
      if (c_id === undefined) continue;
      probes.push({
        entity: entity.id,
        determined: { value: false },
        constraint: (id) => ({ id, type: 'circle_radius', c_id, radius: entity.radius }),
      });
    }
  }
  return probes;
}

/** How many of an entity's probed coordinates came back determined. */
function settle(probes: readonly Probe[]): ReadonlyMap<Id, { fixed: number; total: number }> {
  const settled = new Map<Id, { fixed: number; total: number }>();
  for (const probe of probes) {
    const entry = settled.get(probe.entity) ?? { fixed: 0, total: 0 };
    entry.total++;
    if (probe.determined.value) entry.fixed++;
    settled.set(probe.entity, entry);
  }
  return settled;
}

/** A point is fully constrained when both coordinates are; curves follow. */
function entityStatus(entity: Entity, settled: ReadonlyMap<Id, { fixed: number; total: number }>): EntityStatus {
  const of = (id: Id): boolean => {
    const entry = settled.get(id);
    return entry !== undefined && entry.total > 0 && entry.fixed === entry.total;
  };
  switch (entity.kind) {
    case 'point':
      return of(entity.id) ? 'fully' : 'under';
    case 'line':
      return of(entity.p1) && of(entity.p2) ? 'fully' : 'under';
    case 'arc':
      return of(entity.center) && of(entity.start) && of(entity.end) ? 'fully' : 'under';
    case 'circle':
      return of(entity.center) && of(entity.id) ? 'fully' : 'under';
  }
}

/**
 * Status of geometry no constraint refers to. It adds nothing to the system,
 * so its points decide everything — and its own radius, for a circle, is free.
 */
function derivedStatus(entity: Entity, statuses: ReadonlyMap<Id, EntityStatus>): EntityStatus {
  const of = (id: Id): boolean => statuses.get(id) === 'fully';
  switch (entity.kind) {
    case 'point':
      return 'under';
    case 'line':
      return of(entity.p1) && of(entity.p2) ? 'fully' : 'under';
    case 'arc':
      return of(entity.center) && of(entity.start) && of(entity.end) ? 'fully' : 'under';
    case 'circle':
      return 'under';
  }
}

/**
 * Splits the sketch into components that cannot influence each other.
 *
 * The link is a *constraint*: two entities belong together when some
 * constraint refers to both, or to a curve built on one of them and to the
 * other. Points that only unconstrained geometry passes through are not
 * linked, because such geometry adds no equations and no parameters — which
 * is what keeps, say, the rows of a polyline grid apart.
 */
function componentsOf(sketch: Sketch): { components: Component[]; derived: Entity[] } {
  const index = indexEntities(sketch);
  const referenced = new Set<Id>();
  for (const constraint of sketch.constraints) {
    for (const id of constraintRefs(constraint)) {
      if (index.has(id)) referenced.add(id);
    }
  }
  const active = new Set<Id>(referenced);
  for (const id of referenced) {
    const entity = index.get(id);
    if (entity === undefined) continue;
    for (const point of definingPoints(entity)) {
      if (index.has(point)) active.add(point);
    }
  }

  const parent = new Map<Id, Id>();
  const find = (id: Id): Id => {
    let root = id;
    let next = parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = parent.get(root);
    }
    return root;
  };
  const union = (a: Id, b: Id): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Active curves tie their points together.
  for (const id of active) {
    const entity = index.get(id);
    if (entity === undefined) continue;
    for (const point of definingPoints(entity)) {
      if (active.has(point)) union(id, point);
    }
  }
  // Constraints tie everything they refer to.
  for (const constraint of sketch.constraints) {
    const refs = constraintRefs(constraint).filter((id) => active.has(id));
    for (const ref of refs) union(ref, refs[0]!);
  }

  const byRoot = new Map<Id, Entity[]>();
  for (const entity of sketch.entities) {
    if (!active.has(entity.id)) continue;
    const root = find(entity.id);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [entity]);
    else bucket.push(entity);
  }
  const constraintsOf = new Map<Id, Constraint[]>();
  for (const constraint of sketch.constraints) {
    const refs = constraintRefs(constraint).filter((id) => active.has(id));
    const root = refs.length === 0 ? constraint.id : find(refs[0]!);
    const bucket = constraintsOf.get(root);
    if (bucket === undefined) constraintsOf.set(root, [constraint]);
    else bucket.push(constraint);
  }

  // Buckets are filled in sketch order, so each component's entities keep the
  // order the user drew them — which is what keeps probes grouped sensibly.
  const components: Component[] = [...byRoot].map(([root, entities]) => {
    const constraints = constraintsOf.get(root) ?? [];
    return { entities, constraints, grounded: constraints.some((c) => c.kind === 'fix') };
  });
  const derived = sketch.entities.filter((entity) => !active.has(entity.id));
  return { components, derived };
}

/**
 * Group-tests candidate probes against a component's system. A batch that
 * leaves the DOF alone is entirely determined, one that lowers it by its own
 * size is entirely free; anything else — including a batch that fails to solve
 * — is narrowed. See the file comment for why this is sound while trusting the
 * redundant list of a large batch is not.
 *
 * Narrowing stops at small batches, which are probed a point at a time: the
 * recursion's internal nodes would otherwise cost as many solves as the
 * answers they produce.
 *
 * Every batch starts from a freshly loaded system. `clear_by_id` removes a
 * constraint but not the parameter its value lives in, so reusing one system
 * would grow planegcs' parameter vector — and the Jacobian it builds for each
 * solve — with every probe, which is what runs it out of memory on big
 * sketches.
 */
function resolve(
  gcs: GcsWrapper,
  primitives: readonly SketchPrimitive[],
  baseDof: number,
  probes: readonly Probe[],
): void {
  let counter = 0;
  const test = (batch: readonly Probe[]): 'full' | 'free' | 'split' => {
    gcs.clear_data();
    gcs.push_primitives_and_params([...primitives]);
    for (const probe of batch) {
      gcs.push_primitive(probe.constraint(`probe:${counter++}`));
    }
    const status = gcs.solve(Algorithm.DogLeg);
    const dof = gcs.gcs.dof();
    if (status !== SolveStatus.Success && status !== SolveStatus.Converged) {
      // A probe only fails when its value disagrees with the sketch, which
      // happens when the sketch was drawn away from its own solution. Narrow
      // so that one bad probe does not decide the whole batch.
      return 'split';
    }
    const drop = baseDof - dof;
    if (drop === 0) return 'full';
    if (drop === batch.length) return 'free';
    return 'split';
  };

  // Cap the batch so planegcs never builds a Jacobian much larger than the
  // sketch's own; `MAX_BATCH` is even, so slices never split a point's pair.
  for (let start = 0; start < probes.length; start += MAX_BATCH) {
    walk(probes.slice(start, start + MAX_BATCH));
  }

  function walk(batch: readonly Probe[]): void {
    if (batch.length === 0) return;
    if (batch.length <= LEAF && batch.length > 2) {
      // Small and mixed: settle each point's pair on its own. Testing the
      // batch as a whole first would cost more solves than it can save.
      for (let i = 0; i < batch.length; i += 2) walk(batch.slice(i, i + 2));
      return;
    }
    const result = test(batch);
    if (result === 'full') {
      for (const probe of batch) probe.determined.value = true;
      return;
    }
    if (result === 'free' || batch.length === 1) return;
    // Halve on an even boundary so pairs stay together.
    const middle = Math.max(1, (batch.length >> 1) & ~1);
    walk(batch.slice(0, middle));
    walk(batch.slice(middle));
  }
}
