import { paramDefs, paramRefCount } from '../core/params';
import type { Editor } from '../editor/editor';
import type { Key, Params, Translator } from '../i18n/i18n';
import { icon } from './icons';
import './parameters.css';

/** One parameter row's data, as `paramDefs` reports it (params.ts pins the shape). */
type ParamDef = ReturnType<typeof paramDefs>[number];

/** What a failed parameter edit reports (editor.ts pins the shape). */
interface ParamFailure {
  readonly ok: false;
  readonly error: string;
  readonly detail?: string;
  readonly count?: number;
}

/** What an editor parameter edit returns: success, or a failure to report. */
type ParamEdit = { readonly ok: true } | ParamFailure;

/**
 * The next free default parameter name: d0, d1, … — the lowest index whose `d<i>` the sketch does
 * not already define. Only the canonical spelling counts, so an existing `d00` does not block `d0`.
 */
export function nextParamName(params: Readonly<Record<string, number>>): string {
  for (let i = 0; ; i++) {
    const name = `d${i}`;
    if (!(name in params)) return name;
  }
}

/**
 * The message key (and interpolation params) a parameter edit's failure maps
 * to: expression errors all read as a syntax problem, the rest name the exact
 * rule that was broken. The mapping itself is locale-independent, so the
 * translator is unused here — the caller localizes with `t.t(key, params)`.
 */
export function paramErrorMessage(
  error: string,
  _t: Translator,
  detail?: string,
  count?: number,
): { readonly key: Key; readonly params: Params } {
  switch (error) {
    case 'invalidName':
      return { key: 'parameters.invalidName', params: {} };
    case 'duplicateName':
      return { key: 'parameters.duplicateName', params: {} };
    case 'cycle':
      return { key: 'parameters.cycle', params: {} };
    case 'unknownName':
      return { key: 'parameters.unknownName', params: { name: detail ?? '' } };
    case 'inUse':
      return { key: 'parameters.inUse', params: { count: count ?? 0 } };
    case 'solveFailed':
      return { key: 'status.solveFailed', params: {} };
    default:
      // syntax, arity, unknownFunction, divisionByZero, domain, notFinite,
      // unexpectedEnd — and anything unrecognized — read as a syntax problem:
      // re-typing the expression is the fix for every one of them.
      return { key: 'parameters.syntax', params: {} };
  }
}

/** Avoids re-announcing unchanged text to screen readers. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** The live elements of one rendered row. */
interface Row {
  readonly element: HTMLElement;
  readonly name: HTMLInputElement;
  readonly expression: HTMLInputElement;
  readonly value: HTMLElement;
  readonly remove: HTMLButtonElement;
  readonly error: HTMLElement;
}

/** Where focus was when a rebuild started, so it can be put back afterwards. */
interface FocusState {
  readonly key: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Modal dialog for Inventor's 参数: the sketch's user parameters, one row each
 * with its name, its expression and the resolved value. Edits go straight to
 * the editor (add / rename / set / delete), and while the dialog is open the
 * rows track the sketch through `editor.subscribe` — including changes the
 * canvas makes.
 *
 * The card is `element`; a dimmed backdrop is created with it and both are
 * appended to `document.body` while open. Closed by Esc, the ✕ button or a
 * backdrop click; focus is trapped inside and returns to the invoker on close.
 * No DOM is built at module scope, so the module imports cleanly under Node
 * (where `document` is absent) — the pure helpers above stay testable there.
 */
export class ParametersDialog {
  readonly element: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly list: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  /** Rendered parameter rows, by parameter name. */
  private readonly rows = new Map<string, Row>();
  /** Every editable input, by the focus key its row gave it. */
  private readonly inputs = new Map<string, HTMLInputElement>();
  /** The row being created, between the Add click and its commit or Esc. */
  private createRow: Row | undefined;
  /** Names plus displayed sources; a change rebuilds the rows. */
  private structure = '';
  private unsubscribe: (() => void) | undefined;
  private invoker: HTMLElement | undefined;
  private opened = false;
  /** Set while rows are swapped, so a detached input's blur must not commit. */
  private rebuilding = false;
  /** The focus key the last successful edit asked for. */
  private pendingFocus: string | undefined;
  private readonly titleId = 'parameters-dialog-title';

  constructor(
    private readonly editor: Editor,
    private readonly t: Translator,
  ) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'parameters-backdrop';

    this.element = document.createElement('div');
    this.element.className = 'parameters';
    this.element.tabIndex = -1;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', this.titleId);
    this.backdrop.append(this.element);

    const title = document.createElement('h2');
    title.className = 'parameters-title';
    title.id = this.titleId;
    title.textContent = t.t('parameters.label');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'parameters-close';
    close.setAttribute('aria-label', t.t('parameters.close'));
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());

    const header = document.createElement('header');
    header.className = 'parameters-header';
    header.append(title, close);

    const help = document.createElement('p');
    help.className = 'parameters-help';
    help.textContent = t.t('parameters.help');

    this.list = document.createElement('ul');
    this.list.className = 'parameters-rows';

    this.emptyHint = document.createElement('p');
    this.emptyHint.className = 'parameters-empty';
    this.emptyHint.hidden = true;
    this.emptyHint.textContent = t.t('parameters.empty');

    this.addButton = this.action('parameters.add', () => this.addRow());

    const actions = document.createElement('footer');
    actions.className = 'parameters-actions';
    actions.append(
      this.addButton,
      this.action('parameters.close', () => this.close()),
    );

    this.element.append(header, help, this.list, this.emptyHint, actions);

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
    this.pendingFocus = undefined;
    this.createRow = undefined;
    this.refresh();
    // A fresh visit shows no error left over from the last one.
    for (const row of this.rows.values()) this.hideError(row);
    document.body.append(this.backdrop);
    this.unsubscribe = this.editor.subscribe(() => this.refresh());
    (this.inputs.values().next().value ?? this.element).focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pendingFocus = undefined;
    // Closing discards a half-typed new row; nothing was committed for it.
    const creating = this.createRow;
    this.createRow = undefined;
    creating?.element.remove();
    this.backdrop.remove();
    this.invoker?.focus();
    this.invoker = undefined;
  }

  // ── Rows ──────────────────────────────────────────────────────────────

  /** Rebuilds the rows when the row set changes, otherwise updates in place. */
  private refresh(): void {
    const defs = paramDefs(this.editor.sketch);
    // A parameter's displayed source is `String(value)` when it is a plain one
    // (paramDefs fills that in), so this also tracks canvas-driven value changes.
    const signature = defs.map((def) => `${def.name}=${def.expression}`).join('\u0000');
    if (signature !== this.structure) {
      this.structure = signature;
      this.render(defs);
    } else {
      this.update(defs);
    }
    this.syncEmpty(defs);
  }

  private render(defs: readonly ParamDef[]): void {
    // The swap detaches the old inputs; their blur handlers must not commit
    // what the rebuild is about to replace anyway.
    this.rebuilding = true;
    const focus = this.captureFocus();
    this.rows.clear();
    this.inputs.clear();
    const items: HTMLElement[] = [];
    for (const def of defs) {
      const row = this.row(def);
      this.rows.set(def.name, row);
      items.push(row.element);
    }
    if (this.createRow !== undefined) items.push(this.createRow.element);
    this.list.replaceChildren(...items);
    this.rebuilding = false;
    this.restoreFocus(focus);
    this.focusPending();
  }

  /** Refreshes what can change without the row set changing: values and reference counts. */
  private update(defs: readonly ParamDef[]): void {
    for (const def of defs) {
      const row = this.rows.get(def.name);
      if (row === undefined) continue;
      setText(row.value, this.t.number(this.editor.sketch.params[def.name] ?? 0, 2));
      this.syncRemove(row, def.name);
    }
  }

  private row(def: ParamDef): Row {
    const row = this.buildRow(def.name, def.name, def.expression);
    setText(row.value, this.t.number(this.editor.sketch.params[def.name] ?? 0, 2));
    this.syncRemove(row, def.name);
    row.remove.addEventListener('click', () => this.deleteParam(def.name));
    this.inputs.set(`name:${def.name}`, row.name);
    this.inputs.set(`expr:${def.name}`, row.expression);
    this.bind(row, def);
    return row;
  }

  /**
   * Builds one row's elements. `key` namespaces the focus keys — a
   * parameter's name, or `create` for the row being added.
   */
  private buildRow(key: string, name: string, source: string): Row {
    const li = document.createElement('li');
    li.className = 'parameters-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'parameters-name';
    nameInput.value = name;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.dataset['key'] = `${key}:name`;
    nameInput.setAttribute('aria-label', this.t.t('parameters.name'));

    const expression = document.createElement('input');
    expression.type = 'text';
    expression.className = 'parameters-expression';
    expression.value = source;
    expression.autocomplete = 'off';
    expression.spellcheck = false;
    expression.dataset['key'] = `${key}:expr`;
    expression.setAttribute('aria-label', this.t.t('parameters.expression'));

    const value = document.createElement('span');
    value.className = 'parameters-value';
    value.setAttribute('aria-label', this.t.t('parameters.value'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'parameters-remove';
    remove.setAttribute('aria-label', this.t.t('parameters.remove'));
    remove.append(icon('delete', 14));

    const error = document.createElement('p');
    error.className = 'parameters-error';
    error.hidden = true;

    li.append(nameInput, expression, value, remove, error);
    return { element: li, name: nameInput, expression, value, remove, error };
  }

  /** The delete button is disabled while anything still references the parameter. */
  private syncRemove(row: Row, name: string): void {
    const count = paramRefCount(this.editor.sketch, name);
    row.remove.disabled = count > 0;
    if (count > 0) row.remove.title = this.t.t('parameters.inUse', { count });
    else row.remove.removeAttribute('title');
  }

  private action(labelKey: Key, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'parameters-action';
    button.textContent = this.t.t(labelKey);
    button.addEventListener('click', run);
    return button;
  }

  /** The empty hint replaces the row list while the sketch has no parameters. */
  private syncEmpty(defs: readonly ParamDef[]): void {
    const empty = defs.length === 0 && this.createRow === undefined;
    this.list.hidden = empty;
    this.emptyHint.hidden = !empty;
  }

  // ── Editing ───────────────────────────────────────────────────────────

  /** Wires one row's two fields: Enter commits, Esc reverts, blur commits a real edit. */
  private bind(row: Row, def: ParamDef): void {
    row.name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitRename(row, def, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.revert(row.name, def.name, row.error);
      }
    });
    row.name.addEventListener('blur', () => {
      if (this.rebuilding) return;
      this.commitRename(row, def, false);
    });

    row.expression.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitExpression(row, def, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.revert(row.expression, def.expression, row.error);
      }
    });
    row.expression.addEventListener('blur', () => {
      if (this.rebuilding) return;
      this.commitExpression(row, def, false);
    });
  }

  /**
   * Runs an editor edit with this dialog's subscription paused, so the refresh
   * that follows is driven by the commit's own outcome — a rebuild on success,
   * an error in place on failure — instead of racing the editor's notification.
   */
  private runCommit(run: () => ParamEdit): ParamEdit {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const result = run();
    if (this.opened) this.unsubscribe = this.editor.subscribe(() => this.refresh());
    return result;
  }

  private commitRename(row: Row, def: ParamDef, keepFocus: boolean): void {
    const to = row.name.value.trim();
    // An unchanged name is not an edit; sending it anyway would only pause and
    // resume the subscription for nothing.
    if (to === def.name) {
      this.revert(row.name, def.name, row.error);
      return;
    }
    const result = this.runCommit(() => this.editor.renameParam(def.name, to));
    if (!result.ok) {
      this.showFailure(row, row.name, result, keepFocus);
      return;
    }
    this.pendingFocus = `name:${to}`;
    this.refresh();
  }

  private commitExpression(row: Row, def: ParamDef, keepFocus: boolean): void {
    const expression = row.expression.value.trim();
    // An unchanged expression must not reach the editor either: it would push
    // a pointless undo step (and freeze a plain parameter into a literal).
    if (expression === def.expression.trim()) {
      this.revert(row.expression, def.expression, row.error);
      return;
    }
    const result = this.runCommit(() => this.editor.setParam(def.name, expression));
    if (!result.ok) {
      this.showFailure(row, row.expression, result, keepFocus);
      return;
    }
    this.pendingFocus = `expr:${def.name}`;
    this.refresh();
    // The rebuild restored what was typed; show the source the sketch stores,
    // which the editor may have normalized.
    const stored = paramDefs(this.editor.sketch).find((d) => d.name === def.name);
    const input = this.inputs.get(`expr:${def.name}`);
    if (input !== undefined && stored !== undefined) input.value = stored.expression;
  }

  /** Enter in the new row: both fields must be filled in, then addParam runs. */
  private commitCreate(row: Row): void {
    const name = row.name.value.trim();
    const expression = row.expression.value.trim();
    // An empty field is a syntax error on that field — there is nothing to
    // send to the editor yet.
    if (name === '') {
      this.showError(row, row.name, this.t.t('parameters.syntax'), true);
      return;
    }
    if (expression === '') {
      this.showError(row, row.expression, this.t.t('parameters.syntax'), true);
      return;
    }
    const result = this.runCommit(() => this.editor.addParam(name, expression));
    if (!result.ok) {
      // A rejected name is fixed in the name field; anything else in the expression.
      const input =
        result.error === 'invalidName' || result.error === 'duplicateName'
          ? row.name
          : row.expression;
      this.showFailure(row, input, result, true);
      return;
    }
    this.createRow = undefined;
    this.pendingFocus = `expr:${name}`;
    this.refresh();
  }

  private deleteParam(name: string): void {
    const row = this.rows.get(name);
    if (row === undefined) return;
    const result = this.runCommit(() => this.editor.deleteParam(name));
    if (!result.ok) {
      // e.g. a reference appeared since the last refresh.
      this.showFailure(row, row.name, result, false);
      this.refresh();
      return;
    }
    this.refresh();
  }

  /** Esc (or an unchanged blur): the field goes back to the stored text. */
  private revert(input: HTMLInputElement, text: string, error: HTMLElement): void {
    input.value = text;
    input.removeAttribute('aria-invalid');
    error.hidden = true;
  }

  /** Maps an edit failure onto its localized message and shows it under the row. */
  private showFailure(
    row: Row,
    input: HTMLInputElement,
    failure: ParamFailure,
    keepFocus: boolean,
  ): void {
    const { key, params } = paramErrorMessage(failure.error, this.t, failure.detail, failure.count);
    this.showError(row, input, this.t.t(key, params), keepFocus);
  }

  /** Shows `message` under the row and flags the field that caused it. */
  private showError(row: Row, input: HTMLInputElement, message: string, keepFocus: boolean): void {
    input.setAttribute('aria-invalid', 'true');
    setText(row.error, message);
    row.error.hidden = false;
    // The user stays in the offending field, text selected, so the fix is one
    // keystroke away. A failed delete leaves focus on the button instead.
    if (keepFocus) {
      input.focus();
      input.select();
    }
  }

  private hideError(row: Row): void {
    row.name.removeAttribute('aria-invalid');
    row.expression.removeAttribute('aria-invalid');
    row.error.hidden = true;
  }

  // ── The new row ───────────────────────────────────────────────────────

  /** Appends a new row in "creating" mode, named after the first free d-index. */
  private addRow(): void {
    if (this.createRow !== undefined) {
      this.createRow.expression.focus();
      return;
    }
    const row = this.buildRow('create', nextParamName(this.editor.sketch.params), '');
    this.createRow = row;
    this.bindCreate(row);
    this.list.append(row.element);
    this.syncEmpty(paramDefs(this.editor.sketch));
    row.expression.focus();
  }

  /** The new row commits on Enter only: leaving it must not add half a parameter. */
  private bindCreate(row: Row): void {
    row.name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        row.expression.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelCreate();
      }
    });
    row.expression.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitCreate(row);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelCreate();
      }
    });
    row.remove.addEventListener('click', () => this.cancelCreate());
  }

  /** Esc (or the row's ✕) in the new row: drop it, commit nothing. */
  private cancelCreate(): void {
    const row = this.createRow;
    if (row === undefined) return;
    this.createRow = undefined;
    row.element.remove();
    this.syncEmpty(paramDefs(this.editor.sketch));
    this.addButton.focus();
  }

  // ── Focus ─────────────────────────────────────────────────────────────

  /** The input a focus key points at, across the parameter rows and the new row. */
  private inputByKey(key: string): HTMLInputElement | undefined {
    if (key === 'create:name') return this.createRow?.name;
    if (key === 'create:expr') return this.createRow?.expression;
    return this.inputs.get(key);
  }

  private captureFocus(): FocusState | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !this.element.contains(active)) return undefined;
    const key = active.dataset['key'];
    if (key === undefined) return undefined;
    return {
      key,
      value: active.value,
      start: active.selectionStart ?? 0,
      end: active.selectionEnd ?? 0,
    };
  }

  private restoreFocus(focus: FocusState | undefined): void {
    if (focus === undefined) return;
    const input = this.inputByKey(focus.key);
    if (input === undefined) return;
    input.value = focus.value;
    input.setSelectionRange(focus.start, focus.end);
    input.focus();
  }

  /** Focuses the field the last successful edit asked for, once its row exists. */
  private focusPending(): void {
    const key = this.pendingFocus;
    if (key === undefined) return;
    const input = this.inputByKey(key);
    // The row may not be there yet; the request waits for the next render.
    if (input === undefined) return;
    this.pendingFocus = undefined;
    input.focus();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Text fields revert their own edit (or drop the new row); anywhere
      // else Esc closes the dialog.
      if (event.target instanceof HTMLInputElement) return;
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
    const nodes = this.element.querySelectorAll<HTMLElement>('button, input');
    return [...nodes].filter((el) => !el.hasAttribute('disabled'));
  }
}
