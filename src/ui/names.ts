import { constraintRefs } from '../core/edit';
import type { Constraint, Entity, Id } from '../core/model';
import type { Sketch } from '../core/sketch';
import type { Translator } from '../i18n/i18n';

/**
 * Human-readable names in Inventor's style (直线1, 圆弧2, …), numbered per
 * kind in creation order. Internal ids never reach the UI.
 */
export class Names {
  private readonly numbers = new Map<Id, number>();
  private readonly kinds = new Map<Id, Entity>();

  constructor(
    sketch: Sketch,
    private readonly t: Translator,
  ) {
    const counters = new Map<string, number>();
    for (const e of sketch.entities) {
      const n = (counters.get(e.kind) ?? 0) + 1;
      counters.set(e.kind, n);
      this.numbers.set(e.id, n);
      this.kinds.set(e.id, e);
    }
  }

  entity(id: Id): string {
    const e = this.kinds.get(id);
    if (e === undefined) return id;
    const name = this.t.t(`entities.${e.kind}`, { n: this.numbers.get(id) ?? 0 });
    return e.kind !== 'point' && e.construction === true ? this.t.t('entities.construction', { name }) : name;
  }

  constraint(c: Constraint): string {
    const targets = constraintRefs(c)
      .map((id) => {
        const e = this.kinds.get(id);
        return e === undefined ? id : this.t.t(`entities.${e.kind}`, { n: this.numbers.get(id) ?? 0 });
      })
      .join(this.t.locale === 'zh-CN' ? '、' : ', ');
    return this.t.t('constraints.label', { kind: this.t.t(`constraints.${c.kind}`), targets });
  }
}
