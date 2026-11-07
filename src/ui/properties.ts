import type { Id } from '../core/model';
import type { Editor } from '../editor/editor';
import type { Translator } from '../i18n/i18n';
import { constraintIcon } from './constraint-icons';
import { Names } from './names';
import { buildModel, findField, parseNumber } from './properties-model';
import type {
  ConstraintItem,
  EditTarget,
  Field,
  PropertiesModel,
  Row,
  Section,
  TriState,
} from './properties-model';
import './properties.css';

const COLLAPSE_KEY = 'svgc.propertiesCollapsed';

interface FocusState {
  readonly key: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Right-hand collapsible properties panel (Illustrator "Properties" /
 * Inventor property panel). Shows the current selection and edits it.
 *
 * `update()` runs on every hover and mouse move, so the DOM is rebuilt only
 * when the selection or the sketch's structure changes; values are refreshed
 * in place, and an input the user is typing in is never replaced.
 */
export class PropertiesPanel {
  readonly element = document.createElement('aside');

  private readonly title = document.createElement('h2');
  private readonly badge = document.createElement('span');
  private readonly toggle = document.createElement('button');
  private readonly body = document.createElement('div');
  /** Value elements and constraint items by key, for in-place refresh. */
  private readonly nodes = new Map<string, HTMLElement>();
  /** Error message of each editable field, by field key. */
  private readonly errors = new Map<string, HTMLElement>();
  private model: PropertiesModel;
  private structure = '';
  private collapsed: boolean;
  private nextId = 1;

  constructor(
    private readonly editor: Editor,
    private readonly t: Translator,
  ) {
    this.element.className = 'properties';
    this.element.setAttribute('aria-label', t.t('properties.label'));
    this.collapsed = localStorage.getItem(COLLAPSE_KEY) === 'true';
    this.body.id = 'properties-body';

    this.title.className = 'properties-title';
    this.badge.className = 'properties-badge';
    this.badge.hidden = true;
    this.toggle.className = 'properties-toggle';
    this.toggle.type = 'button';
    this.toggle.append(chevron('right'));
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    const header = document.createElement('header');
    header.className = 'properties-header';
    header.append(this.title, this.badge, this.toggle);
    this.body.className = 'properties-body';
    this.toggle.setAttribute('aria-controls', this.body.id);
    this.element.append(header, this.body);

    this.model = this.buildModel();
    this.update();
  }

  /** Refreshes the panel for the current selection, sketch and hover state. */
  update(): void {
    this.syncCollapsed();
    const model = this.buildModel();
    this.model = model;
    const structure = this.structureSignature();
    if (structure !== this.structure) {
      this.structure = structure;
      this.render(model);
    }
    this.refresh(model);
  }

  // ── Model ──────────────────────────────────────────────────────────────

  private buildModel(): PropertiesModel {
    const editor = this.editor;
    return buildModel({
      sketch: editor.sketch,
      selection: editor.selection,
      status: editor.status,
      solve: editor.solve,
      names: new Names(editor.sketch, this.t),
      t: this.t,
    });
  }

  /** Changes only when the panel's set of rows changes, not when values do. */
  private structureSignature(): string {
    const { sketch, selection } = this.editor;
    return [
      [...selection].join(','),
      sketch.entities.map((e) => `${e.id}:${e.kind}`).join(','),
      sketch.constraints.map((c) => `${c.id}:${c.kind}`).join(','),
      Object.keys(sketch.params).join(','),
    ].join('|');
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private render(model: PropertiesModel): void {
    const focus = this.captureFocus();
    this.nodes.clear();
    this.errors.clear();
    this.body.replaceChildren(...model.sections.map((section) => this.section(section)));
    this.restoreFocus(focus);
  }

  private section(section: Section): HTMLElement {
    const el = document.createElement('section');
    el.className = 'properties-section';
    const heading = document.createElement('h3');
    heading.className = 'properties-section-title';
    heading.textContent = section.title;
    el.append(heading);
    switch (section.kind) {
      case 'fields':
        el.append(this.fields(section.fields));
        break;
      case 'rows':
        el.append(this.rows(section.rows));
        break;
      case 'items':
        el.append(this.items(section.items));
        break;
      case 'construction':
        el.append(this.construction(section.title, section.state));
        break;
    }
    return el;
  }

  private fields(fields: readonly Field[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'properties-fields';
    for (const field of fields) el.append(this.field(field));
    return el;
  }

  private field(field: Field): HTMLElement {
    const row = document.createElement('div');
    row.className = 'properties-field';
    const id = `properties-field-${this.nextId++}`;

    const label = document.createElement('label');
    label.className = 'properties-label';
    label.htmlFor = id;
    label.textContent = field.label;
    row.append(label);

    if (field.editable) {
      const input = document.createElement('input');
      input.className = 'properties-input';
      input.id = id;
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset['field'] = field.key;
      input.value = this.t.number(field.value, 2);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.applyField(input, field.key, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.resetField(input, field.key);
        }
      });
      // Blur commits too, but an invalid entry there is reverted instead of
      // stealing focus back from wherever the user went.
      input.addEventListener('blur', () => this.applyField(input, field.key, false));
      row.append(input);
      this.nodes.set(field.key, input);
    } else {
      const value = document.createElement('span');
      value.className = 'properties-value';
      value.id = id;
      value.textContent = this.t.number(field.value, 2);
      row.append(value);
      this.nodes.set(field.key, value);
    }

    const error = document.createElement('p');
    error.className = 'properties-error';
    error.id = `${id}-error`;
    error.hidden = true;
    row.append(error);
    this.errors.set(field.key, error);
    return row;
  }

  private rows(rows: readonly Row[]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'properties-rows';
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'properties-empty';
      empty.textContent = this.t.t('browser.empty');
      el.append(empty);
      return el;
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'properties-row';
      const label = document.createElement('span');
      label.className = 'properties-label';
      label.textContent = row.label;
      const value = document.createElement('span');
      value.className = row.mono === true ? 'properties-value mono' : 'properties-value';
      value.textContent = row.text;
      line.append(label, value);
      this.nodes.set(row.key, value);
      el.append(line);
    }
    return el;
  }

  private items(items: readonly ConstraintItem[]): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'properties-items';
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'properties-empty';
      empty.textContent = this.t.t('browser.empty');
      list.append(empty);
      return list;
    }
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'properties-item';
      button.dataset['id'] = item.id;
      button.append(constraintIcon(item.glyph, 14));
      const name = document.createElement('span');
      name.textContent = item.name;
      button.append(name);
      button.addEventListener('click', () => this.editor.select([item.id]));
      button.addEventListener('pointerover', () => this.editor.setHover(item.id));
      button.addEventListener('pointerleave', () => this.editor.setHover(undefined));
      li.append(button);
      this.nodes.set(`item:${item.id}`, button);
      list.append(li);
    }
    return list;
  }

  private construction(title: string, state: TriState): HTMLElement {
    const row = document.createElement('div');
    row.className = 'properties-check';
    const id = `properties-check-${this.nextId++}`;
    const input = document.createElement('input');
    input.className = 'properties-checkbox';
    input.id = id;
    input.type = 'checkbox';
    input.checked = state === 'on';
    input.indeterminate = state === 'mixed';
    input.addEventListener('change', () => {
      const current = this.constructionSection();
      if (current === undefined) return;
      this.editor.setConstruction(current.curves, current.state !== 'on');
    });
    const label = document.createElement('label');
    label.className = 'properties-check-label';
    label.htmlFor = id;
    label.textContent = title;
    row.append(input, label);
    this.nodes.set('construction', input);
    return row;
  }

  // ── Refresh ────────────────────────────────────────────────────────────

  private refresh(model: PropertiesModel): void {
    setText(this.title, model.title);
    const status = model.status;
    this.badge.hidden = status === undefined;
    if (status !== undefined) {
      setText(
        this.badge,
        this.t.t(status === 'fully' ? 'status.fullyConstrained' : 'properties.under'),
      );
      this.badge.dataset['state'] = status;
    }

    for (const section of model.sections) {
      switch (section.kind) {
        case 'fields':
          for (const field of section.fields) {
            const el = this.nodes.get(field.key);
            if (el === undefined) continue;
            const text = this.t.number(field.value, 2);
            if (el instanceof HTMLInputElement) {
              // Never overwrite what the user is typing.
              if (document.activeElement !== el) el.value = text;
            } else {
              setText(el, text);
            }
          }
          break;
        case 'rows':
          for (const row of section.rows) {
            const el = this.nodes.get(row.key);
            if (el !== undefined) setText(el, row.text);
          }
          break;
        case 'items':
          for (const item of section.items) {
            const el = this.nodes.get(`item:${item.id}`);
            if (el === undefined) continue;
            el.classList.toggle('hover', this.editor.hover === item.id);
            el.setAttribute('aria-pressed', String(this.editor.selection.has(item.id)));
          }
          break;
        case 'construction': {
          const box = this.nodes.get('construction');
          if (!(box instanceof HTMLInputElement)) break;
          box.checked = section.state === 'on';
          box.indeterminate = section.state === 'mixed';
          break;
        }
      }
    }
  }

  // ── Editing ────────────────────────────────────────────────────────────

  private constructionSection(): { curves: readonly Id[]; state: TriState } | undefined {
    return this.model.sections.find(
      (s): s is Extract<Section, { kind: 'construction' }> => s.kind === 'construction',
    );
  }

  /** Applies what the user typed; the solved value is read back afterwards. */
  private applyField(input: HTMLInputElement, key: string, keepFocus: boolean): void {
    const field = findField(this.buildModel(), key);
    if (field?.target === undefined) return;
    const parsed = parseNumber(input.value, this.editor.sketch.params);
    if (!parsed.ok) {
      if (!keepFocus) {
        input.value = this.t.number(field.value, 2);
        this.clearError(input, key);
        return;
      }
      this.showError(input, key, parsed.error);
      input.focus();
      return;
    }
    this.apply(field.target, parsed.value, input.value);
    this.clearError(input, key);
    const solved = findField(this.buildModel(), key);
    input.value = this.t.number(solved?.value ?? parsed.value, 2);
  }

  /** Esc: back to the value the model holds, without committing anything. */
  private resetField(input: HTMLInputElement, key: string): void {
    const field = findField(this.model, key);
    if (field !== undefined) input.value = this.t.number(field.value, 2);
    this.clearError(input, key);
  }

  private apply(target: EditTarget, value: number, source: string): void {
    const editor = this.editor;
    if (target.kind === 'radius') {
      editor.setCircleRadius(target.curve, value);
      return;
    }
    if (target.kind === 'constraintValue') {
      // Typing a parameter's name binds the dimension to it; anything else stores the number.
      // The editor validates the name, so a bogus one never reaches the solver.
      const name = source.trim();
      const params = editor.sketch.params;
      editor.setConstraintValue(target.constraint, name in params ? name : value);
      return;
    }
    const point = editor.sketch.entities.find((e) => e.id === target.point);
    if (point?.kind !== 'point') return;
    editor.setPointPosition(
      target.point,
      target.axis === 'x' ? value : point.x,
      target.axis === 'y' ? value : point.y,
    );
  }

  private showError(input: HTMLInputElement, key: string, detail: string): void {
    input.setAttribute('aria-invalid', 'true');
    input.title = detail;
    const error = this.errors.get(key);
    if (error === undefined) return;
    setText(error, this.t.t('properties.invalid'));
    error.hidden = false;
  }

  private clearError(input: HTMLInputElement, key: string): void {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('title');
    const error = this.errors.get(key);
    if (error !== undefined) error.hidden = true;
  }

  // ── Focus ──────────────────────────────────────────────────────────────

  private captureFocus(): FocusState | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !this.body.contains(active)) return undefined;
    const key = active.dataset['field'];
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
    const input = this.nodes.get(focus.key);
    if (!(input instanceof HTMLInputElement)) return;
    input.value = focus.value;
    input.setSelectionRange(focus.start, focus.end);
    input.focus();
  }

  // ── Collapse ───────────────────────────────────────────────────────────

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    this.syncCollapsed();
  }

  private syncCollapsed(): void {
    this.element.dataset['collapsed'] = String(this.collapsed);
    this.body.hidden = this.collapsed;
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    this.toggle.setAttribute(
      'aria-label',
      this.t.t(this.collapsed ? 'properties.expand' : 'properties.collapse'),
    );
    this.toggle.replaceChildren(chevron(this.collapsed ? 'left' : 'right'));
  }
}

/** Avoids re-announcing unchanged text to screen readers. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** A chevron in the Tabler outline style, pointing the way the panel moves. */
function chevron(direction: 'left' | 'right'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({
    class: 'icon',
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', direction === 'left' ? 'M14 6l-6 6l6 6' : 'M10 6l6 6l-6 6');
  svg.append(path);
  return svg;
}
