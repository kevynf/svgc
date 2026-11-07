import type { Key, Translator } from '../i18n/i18n';
import { INFERRED_KINDS, settings, type InferredKind } from '../editor/settings';
import { constraintIcon, type ConstraintGlyph } from './constraint-icons';
import './constraint-settings.css';

/** The constraint glyph shown beside each inference kind (Inventor's 约束设置). */
const KIND_GLYPH: Record<InferredKind, ConstraintGlyph> = {
  coincident: 'coincident',
  pointOnCurve: 'pointOnCurve',
  horizontal: 'horizontal',
  vertical: 'vertical',
  parallel: 'parallel',
  perpendicular: 'perpendicular',
  tangent: 'tangent',
};

/** The message key of each kind's row label. */
const KIND_LABEL: Record<InferredKind, Key> = {
  coincident: 'settings.kinds.coincident',
  pointOnCurve: 'settings.kinds.pointOnCurve',
  horizontal: 'settings.kinds.horizontal',
  vertical: 'settings.kinds.vertical',
  parallel: 'settings.kinds.parallel',
  perpendicular: 'settings.kinds.perpendicular',
  tangent: 'settings.kinds.tangent',
};

/** One dialog row: the inference kind, its glyph and its label message key. */
export interface InferenceRow {
  readonly kind: InferredKind;
  readonly glyph: ConstraintGlyph;
  readonly labelKey: Key;
}

/** The dialog's rows, one per inference kind, in `INFERRED_KINDS` order. */
export function inferenceRows(): readonly InferenceRow[] {
  return INFERRED_KINDS.map((kind) => ({
    kind,
    glyph: KIND_GLYPH[kind],
    labelKey: KIND_LABEL[kind],
  }));
}

/** e.g. "已推断 5 / 7 种约束" / "5 of 7 constraint types inferred". */
export function inferenceSummary(inferred: ReadonlySet<InferredKind>, t: Translator): string {
  return t.t('settings.summary', { count: inferred.size, total: INFERRED_KINDS.length });
}

/**
 * Modal dialog for Inventor's 约束设置: chooses which constraint kinds are
 * inferred while drawing. It edits the `settings` store, reflects its current
 * state when opened, and stays live via `settings.subscribe`.
 *
 * The card is `element`; a dimmed backdrop is created with it and both are
 * appended to `document.body` while open. Closed by Esc, the ✕ button or a
 * backdrop click; focus is trapped inside and returns to the invoker on close.
 * All DOM is built in the constructor, so the module imports cleanly under Node
 * (where `document` is absent) — the pure helpers above stay testable there.
 */
export class ConstraintSettingsDialog {
  readonly element: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly checkboxes = new Map<InferredKind, HTMLInputElement>();
  private readonly summary: HTMLElement;
  private readonly noneHint: HTMLElement;
  private readonly titleId = 'settings-dialog-title';
  private unsubscribe: (() => void) | undefined;
  private invoker: HTMLElement | undefined;
  private opened = false;

  constructor(private readonly t: Translator) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'settings-backdrop';

    this.element = document.createElement('div');
    this.element.className = 'settings';
    this.element.tabIndex = -1;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', this.titleId);
    this.backdrop.append(this.element);

    const title = document.createElement('h2');
    title.className = 'settings-title';
    title.id = this.titleId;
    title.textContent = t.t('settings.label');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'settings-close';
    close.setAttribute('aria-label', t.t('settings.close'));
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());

    const header = document.createElement('header');
    header.className = 'settings-header';
    header.append(title, close);

    const help = document.createElement('p');
    help.className = 'settings-help';
    help.textContent = t.t('settings.help');

    const list = document.createElement('ul');
    list.className = 'settings-rows';
    for (const row of inferenceRows()) list.append(this.row(row));

    this.summary = document.createElement('p');
    this.summary.className = 'settings-summary';
    this.noneHint = document.createElement('p');
    this.noneHint.className = 'settings-none';
    this.noneHint.hidden = true;
    this.noneHint.textContent = t.t('settings.noneInferred');

    const actions = document.createElement('footer');
    actions.className = 'settings-actions';
    actions.append(this.action('settings.selectAll', () => this.setAll(true)));
    actions.append(this.action('settings.clearAll', () => this.setAll(false)));
    actions.append(this.action('settings.reset', () => void settings.resetInferred()));

    this.element.append(header, help, list, this.summary, this.noneHint, actions);

    this.element.addEventListener('keydown', (event) => this.onKeydown(event));
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.close();
    });
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(invoker?: HTMLElement): void {
    if (this.opened) return;
    this.opened = true;
    this.invoker = invoker;
    this.refresh();
    document.body.append(this.backdrop);
    this.unsubscribe = settings.subscribe(() => this.refresh());
    (this.checkboxes.values().next().value ?? this.element).focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.backdrop.remove();
    this.invoker?.focus();
    this.invoker = undefined;
  }

  // ── Rows ──────────────────────────────────────────────────────────────

  private row(row: InferenceRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'settings-row';
    const id = `settings-kind-${row.kind}`;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'settings-checkbox';
    box.id = id;
    box.dataset['kind'] = row.kind;
    box.addEventListener('change', () => settings.setInferred(row.kind, box.checked));

    const label = document.createElement('label');
    label.className = 'settings-row-label';
    label.htmlFor = id;
    label.append(constraintIcon(row.glyph, 16));
    const text = document.createElement('span');
    text.textContent = this.t.t(row.labelKey);
    label.append(text);

    li.append(box, label);
    this.checkboxes.set(row.kind, box);
    return li;
  }

  private action(labelKey: Key, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-action';
    button.textContent = this.t.t(labelKey);
    button.addEventListener('click', run);
    return button;
  }

  private setAll(on: boolean): void {
    for (const kind of INFERRED_KINDS) settings.setInferred(kind, on);
  }

  /** Mirrors the store into the checkboxes, the summary and the empty hint. */
  private refresh(): void {
    const inferred = settings.value.inferred;
    for (const [kind, box] of this.checkboxes) box.checked = inferred.has(kind);
    this.summary.textContent = inferenceSummary(inferred, this.t);
    this.noneHint.hidden = inferred.size !== 0;
  }

  // ── Keyboard ──────────────────────────────────────────────────────────

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusables();
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.element.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.element.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusables(): HTMLElement[] {
    const nodes = this.element.querySelectorAll<HTMLElement>('button, input[type="checkbox"]');
    return [...nodes].filter((el) => !el.hasAttribute('disabled'));
  }
}
