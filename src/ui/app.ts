import { constraintRefs, constraintValue } from '../core/edit';
import type { Vec2 } from '../core/geometry';
import type { Id } from '../core/model';
import type { EditRequest, MenuItem, PointerInput } from '../editor/command';
import type { Editor } from '../editor/editor';
import { AliasMatcher } from '../editor/aliases';
import { LOCALES } from '../i18n/i18n';
import type { Key, Locale, Translator } from '../i18n/i18n';
import { parseSketch, serializeSketch } from '../io/sketch-file';
import type { SketchFileError } from '../io/sketch-file';
import { createFileSaver } from '../io/save';
import { sketchToSvg } from '../io/svg';
import { emptySketch, indexEntities } from '../core/sketch';
import { dimensionLayout, dimensionText, isDimensionKind } from '../render/dimensions';
import { SketchView } from '../render/view';
import { AppMenu } from './app-menu';
import { Browser } from './browser';
import { icon } from './icons';
import { MarkingMenu } from './marking-menu';
import { ParametersDialog } from './parameters';
import { PropertiesPanel } from './properties';
import { parseNumber } from './properties-model';
import { settings } from '../editor/settings';
import { constraintPlacements, hitConstraint } from '../render/constraints';
import { ConstraintSettingsDialog } from './constraint-settings';
import { Ribbon } from './ribbon';
import type { RibbonButton, RibbonPanel } from './ribbon';
import type { ConstraintGlyph } from './constraint-icons';
import { StatusBar } from './statusbar';

/**
 * Inventor's default command aliases. Only aliases whose command exists are
 * active; the rest are listed so the ribbon tooltips are complete.
 */
export const COMMAND_ALIASES: readonly (readonly [alias: string, command: string])[] = [
  ['L', 'line'],
  ['C', 'circle'],
  ['A3', 'arc'],
  ['REC', 'rectangle'],
  ['PO', 'point'],
  ['TR', 'trim'],
  ['X', 'extend'],
  ['O', 'offset'],
  ['MI', 'mirror'],
  ['F', 'fillet'],
  ['D', 'dimension'],
  ['=', 'equal'],
  ['-', 'horizontal'],
  ['I', 'vertical'],
  ['CO', 'coincident'],
  ['FI', 'fix'],
  ['PA', 'parallel'],
  ['PN', 'perpendicular'],
  ['TA', 'tangent'],
  ['MI', 'midpoint'],
];

const WHEEL_ZOOM = 1.0015;

/** The names and mime types Save and Export SVG write the document as. */
const SKETCH_FILE = 'Sketch1.svgc.json';
const SVG_FILE = 'Sketch1.svg';
const SKETCH_MIME = 'application/json';
const SVG_MIME = 'image/svg+xml';

export interface AppOptions {
  readonly editor: Editor;
  readonly t: Translator;
  readonly onLocaleChange: (locale: Locale) => void;
}

/** Who asked for the inline value box: a command placing a dimension, or a double-click on one. */
type EditSource = 'command' | 'constraint';

/** Builds the editor shell (title bar, ribbon, browser, canvas, status bar) and routes input. */
export class App {
  readonly element = document.createElement('div');
  private readonly abort = new AbortController();
  private readonly editor: Editor;
  private readonly t: Translator;
  private readonly ribbon: Ribbon;
  private readonly browser: Browser;
  private readonly properties: PropertiesPanel;
  private readonly status: StatusBar;
  private readonly menu: MarkingMenu;
  private readonly canvas: SVGSVGElement;
  private readonly view: SketchView;
  /** The stage the canvas and the marking menu sit in; the edit box is placed in it too. */
  private readonly stage: HTMLElement;
  private readonly aliases: AliasMatcher;
  private readonly unsubscribe: () => void;
  private readonly settingsUnsubscribe: () => void;
  private frame: number | undefined;
  private pendingMove: PointerInput | undefined;
  private pan: { pointer: number; x: number; y: number } | undefined;
  private menuGesture: { pointer: number; x: number; y: number } | undefined;
  /** The inline value box, while it is open — whichever source asked for it. */
  private editInput: HTMLInputElement | undefined;
  /** Whether the user has typed in the value box, i.e. edited the measurement. */
  private editDirty = false;
  /** The dimension a double-click asked to re-value, while its value box is open. */
  private constraintEdit: { readonly constraint: Id; readonly at: Vec2; readonly value: number } | undefined;
  /** Which source the open box belongs to, so a change of source re-opens it. */
  private editSource: EditSource | undefined;
  private readonly settingsDialog: ConstraintSettingsDialog;
  private readonly parametersDialog: ParametersDialog;
  private readonly appMenu: AppMenu;
  /** Remembers the location a save picked, so the next one overwrites it. */
  private readonly saver = createFileSaver();
  /** The hidden file picker Open uses; created once and reused. */
  private fileInput: HTMLInputElement | undefined;

  constructor({ editor, t, onLocaleChange }: AppOptions) {
    this.editor = editor;
    this.t = t;
    this.element.className = 'app';
    this.settingsDialog = new ConstraintSettingsDialog(t);
    this.parametersDialog = new ParametersDialog(editor, t);
    this.appMenu = new AppMenu(
      {
        onNew: () => this.newSketch(),
        onOpen: () => this.openSketch(),
        onSave: () => this.runFileAction(() => this.saveSketch(), 'file.saveFailed'),
        onExportSvg: () => this.runFileAction(() => this.exportSvg(), 'file.saveFailed'),
      },
      t,
    );

    this.ribbon = new Ribbon(t, this.panels());
    this.browser = new Browser(editor, t);
    this.status = new StatusBar(editor, t);
    this.menu = new MarkingMenu(t);

    this.canvas = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.canvas.classList.add('canvas');
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', t.t('app.canvasLabel'));
    this.canvas.setAttribute('tabindex', '0');
    this.view = new SketchView(this.canvas);

    this.stage = document.createElement('main');
    this.stage.className = 'stage';
    this.stage.append(this.canvas, this.menu.element);

    const workspace = document.createElement('div');
    workspace.className = 'workspace';
    workspace.append(this.browser.element, this.stage);

    this.properties = new PropertiesPanel(editor, t);
    workspace.append(this.properties.element);

    // Title bar and ribbon tabs share one row: app name left, language right.
    const head = document.createElement('header');
    head.className = 'titlebar';
    const title = document.createElement('h1');
    title.textContent = `${this.t.t('app.title')} —${this.t.t('app.sketchName')}`;
    const label = document.createElement('label');
    label.className = 'locale';
    label.title = this.t.t('app.language');
    const select = document.createElement('select');
    select.setAttribute('aria-label', this.t.t('app.language'));
    for (const { id, name } of LOCALES) {
      select.append(new Option(name, id, false, id === this.t.locale));
    }
    select.addEventListener('change', () => onLocaleChange(select.value as Locale));
    label.append(icon('language', 14), select);
    head.append(this.appMenu.element, title, this.ribbonTabs(), label);

    this.element.append(head, this.ribbon.element, workspace, this.status.element);

    this.aliases = new AliasMatcher(
      COMMAND_ALIASES.filter(([, command]) => editor.hasCommand(command)),
      (command) => editor.startCommand(command),
    );

    this.bindCanvas(this.stage);
    this.bindKeyboard();
    this.unsubscribe = editor.subscribe(() => this.schedule());
    // F8/F9 and the inference settings change outside the editor; re-render too.
    this.settingsUnsubscribe = settings.subscribe(() => this.schedule());
  }

  /** Call once the element is in the document so the canvas has a size. */
  mount(parent: HTMLElement, fit: boolean): void {
    parent.replaceChildren(this.element);
    const rect = this.canvas.getBoundingClientRect();
    this.editor.viewport.resize(rect.width, rect.height);
    if (fit) this.editor.zoomAll();
    this.render();
    this.canvas.focus();
  }

  dispose(): void {
    this.abort.abort();
    this.unsubscribe();
    this.settingsUnsubscribe();
    this.settingsDialog.close();
    this.parametersDialog.close();
    this.appMenu.close();
    this.fileInput?.remove();
    this.aliases.reset();
    this.closeEdit();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.element.remove();
  }

  // 鈹€鈹€ Layout 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /**
   * The tab row carries the ribbon's controls, so the shell keeps Inventor's
   * two-row header instead of a separate bar above the ribbon.
   */
  private ribbonTabs(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ribbon-tabs';
    row.setAttribute('role', 'tablist');
    const tabButton = document.createElement('button');
    tabButton.className = 'ribbon-tab';
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-selected', 'true');
    tabButton.id = 'ribbon-tab-sketch';
    tabButton.textContent = this.t.t('ribbon.sketchTab');

    row.append(tabButton, this.ribbon.collapseToggle);
    return row;
  }

  private panels(): RibbonPanel[] {
    const e = this.editor;
    const shortcut = (command: string) => COMMAND_ALIASES.find(([, c]) => c === command)?.[0];
    const cmd = (id: string, iconName: RibbonButton['icon'], glyph?: ConstraintGlyph, size: 'large' | 'small' = 'large'): RibbonButton => {
      const keys = shortcut(id);
      return {
        id,
        icon: iconName,
        label: `commands.${id}` as RibbonButton['label'],
        size,
        available: e.hasCommand(id),
        run: () => e.startCommand(id),
        active: () => e.activeCommand.id === id,
        ...(glyph === undefined ? {} : { glyph }),
        ...(keys === undefined ? {} : { shortcut: keys }),
      };
    };
    const hasCurveSelected = () => e.sketch.entities.some((x) => x.kind !== 'point' && e.selection.has(x.id));

    return [
      {
        label: 'ribbon.panels.create',
        buttons: [cmd('line', 'line'), cmd('circle', 'circle'), cmd('arc', 'arc'), cmd('rectangle', 'rectangle'), cmd('point', 'point')],
      },
      {
        label: 'ribbon.panels.modify',
        buttons: [
          cmd('trim', 'trim', undefined, 'small'),
          cmd('extend', 'extend', undefined, 'small'),
          cmd('offset', 'offset', undefined, 'small'),
          cmd('mirror', 'mirror', undefined, 'small'),
          cmd('fillet', 'fillet', undefined, 'small'),
        ],
      },
      {
        label: 'ribbon.panels.constrain',
        buttons: [
          cmd('dimension', 'dimension'),
          cmd('fix', 'fix', 'fix', 'small'),
          cmd('equal', 'equal', 'equal', 'small'),
          cmd('horizontal', 'horizontal', 'horizontal', 'small'),
          cmd('vertical', 'vertical', 'vertical', 'small'),
          cmd('coincident', 'construction', 'coincident', 'small'),
          cmd('parallel', 'construction', 'parallel', 'small'),
          cmd('perpendicular', 'construction', 'perpendicular', 'small'),
          cmd('tangent', 'construction', 'tangent', 'small'),
          cmd('midpoint', 'construction', 'midpoint', 'small'),
          cmd('pointOnLine', 'construction', 'pointOnLine', 'small'),
          cmd('pointOnCurve', 'construction', 'pointOnCurve', 'small'),
        ],
      },
      {
        label: 'ribbon.panels.format',
        buttons: [
          {
            id: 'construction',
            icon: 'construction',
            label: 'commands.construction',
            size: 'small',
            available: true,
            enabled: hasCurveSelected,
            run: () => e.toggleConstruction(),
          },
          cmd('driven', 'driven', undefined, 'small'),
          cmd('artboard', 'artboard', undefined, 'small'),
          {
            id: 'showConstraints',
            icon: 'construction',
            label: 'commands.showConstraints',
            size: 'small',
            shortcut: 'F8',
            available: true,
            run: () => settings.toggleShow(),
            active: () => settings.value.showConstraints,
          },
        ],
      },
      {
        label: 'ribbon.panels.edit',
        buttons: [
          { id: 'undo', icon: 'undo', label: 'commands.undo', size: 'small', shortcut: 'Ctrl+Z', available: true, enabled: () => e.history.canUndo, run: () => e.undo() },
          { id: 'redo', icon: 'redo', label: 'commands.redo', size: 'small', shortcut: 'Ctrl+Y', available: true, enabled: () => e.history.canRedo, run: () => e.redo() },
          { id: 'delete', icon: 'delete', label: 'commands.delete', size: 'small', shortcut: 'Delete', available: true, enabled: () => e.selection.size > 0, run: () => e.deleteSelection() },
        ],
      },
      {
        label: 'ribbon.panels.view',
        buttons: [{ id: 'zoomAll', icon: 'zoomAll', label: 'commands.zoomAll', shortcut: 'Home', size: 'small', available: true, run: () => e.zoomAll() }],
      },
    ];
  }

  // ── File operations ───────────────────────────────────────────────────

  /** New: an empty document, with no history left to undo into. */
  private newSketch(): void {
    this.editor.reset(emptySketch());
  }

  /** Open: shows the file picker; adopting what was picked happens on change. */
  private openSketch(): void {
    // The input is created once and reused: it is hidden, and its value is
    // cleared after every read, so the same file can be picked again.
    this.fileInput ??= this.createFileInput();
    this.fileInput.click();
  }

  private createFileInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.svgc.json,application/json';
    input.hidden = true;
    input.addEventListener('change', () => {
      // A file that cannot be read at all is reported like one that cannot be
      // parsed: either way the document stays as it was.
      this.readSketchFile(input).catch(() => this.openFailed('invalidJson'));
    });
    document.body.append(input);
    return input;
  }

  /** Adopts the picked file, or reports why it could not be read. */
  private async readSketchFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    // Cleared right away, so picking the same file again still fires `change`.
    input.value = '';
    if (file === undefined) return;
    const parsed = parseSketch(await file.text());
    if (parsed.ok) this.editor.reset(parsed.sketch);
    else this.openFailed(parsed.error);
  }

  /** Reports a file that could not be adopted, naming the reason. */
  private openFailed(reason: SketchFileError): void {
    this.editor.setMessage({ key: 'file.openFailed', params: { reason: this.t.t(`file.reason.${reason}`) } });
  }

  /** Save: the sketch as a .svgc.json file, overwriting the location picked last time. */
  private async saveSketch(): Promise<void> {
    await this.saver.save(SKETCH_FILE, SKETCH_MIME, serializeSketch(this.editor.sketch));
  }

  /** Export SVG: the sketch as an image. */
  private async exportSvg(): Promise<void> {
    await this.saver.save(SVG_FILE, SVG_MIME, sketchToSvg(this.editor.sketch));
  }

  /** Runs a file operation fire-and-forget, reporting a failure in the status bar. */
  private runFileAction(run: () => Promise<void>, failure: Key): void {
    run().catch(() => this.editor.setMessage({ key: failure }));
  }

  // 鈹€鈹€ Rendering 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  private schedule(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.render();
    });
  }

  private render(): void {
    const e = this.editor;
    const highlight = new Set<Id>();
    if (e.hover !== undefined) {
      const constraint = e.sketch.constraints.find((c) => c.id === e.hover);
      for (const id of constraint === undefined ? [e.hover] : constraintRefs(constraint)) highlight.add(id);
    }
    const selection = new Set<Id>(e.selection);
    for (const c of e.sketch.constraints) {
      if (e.selection.has(c.id)) for (const id of constraintRefs(c)) selection.add(id);
    }
    // One formatter for every dimension value the canvas draws: a radius reads
    // "R40" the way Inventor draws it, the rest are bare numbers.
    const format = (n: number) => this.t.number(n, 1);
    this.view.render({
      sketch: e.sketch,
      viewport: e.viewport,
      selection,
      highlight,
      constrained: new Set([...e.status].filter(([, s]) => s === 'fully').map(([id]) => id)),
      overlay: e.activeCommand.overlay?.() ?? [],
      cursor: e.cursorWorld,
      showConstraints: settings.value.showConstraints,
      dimensionLabel: (c) => {
        const value = constraintValue(c, e.sketch.params);
        if (value === undefined) return undefined;
        return dimensionText(value, c.kind === 'radius', format);
      },
      // A glyph chip is otherwise mute: it names the constraint it stands for,
      // which is both the tooltip and the accessible name a screen reader reads.
      constraintLabel: (placement) => {
        const kind = this.t.t(`constraints.${placement.glyph}` as Key);
        return this.t.t('constraints.symbol', { kind });
      },
      formatNumber: format,
    });
    this.canvas.dataset['command'] = e.activeCommand.id;
    this.canvas.classList.toggle('panning', this.pan !== undefined);
    this.ribbon.update();
    this.browser.update();
    this.properties.update();
    this.status.update();
    this.syncEdit();
  }

  // ── Inline value box ───────────────────────────────────────────────────

  /**
   * The inline value box: opened when a request appears, repositioned on every
   * render so it follows the value text, and closed as soon as the request goes
   * away. Two things ask for it — the active command while it places a
   * dimension, and a double-click on one already placed — and both get this
   * same box; only where the value goes differs (`commitEditBox`).
   */
  private syncEdit(): void {
    const edit = this.editRequest();
    if (edit === undefined) {
      this.closeEdit();
      return;
    }
    const input = this.editInput;
    // The box is already open on this source: follow the anchor, but never
    // overwrite what the user is typing, exactly like the properties panel
    // refreshes. A box the other source took over is re-opened, so it is never
    // holding one source's value while the other commits.
    if (input !== undefined && this.editSource === edit.source) {
      const at = this.editor.viewport.toScreen(edit.request.at);
      input.style.left = `${at.x}px`;
      input.style.top = `${at.y}px`;
      return;
    }
    if (input !== undefined) this.closeEdit();
    this.editSource = edit.source;
    this.openEdit(edit.request);
  }

  /**
   * What the box should be editing, and which source it came from. The command's
   * own request comes first: it owns the value entry until the dimension it is
   * placing is committed, and taking the box over drops the double-click's
   * request. Otherwise the re-valuing a double-click asked for stands — unless
   * the constraint has since been deleted, which leaves nothing to edit.
   */
  private editRequest(): { readonly source: EditSource; readonly request: EditRequest } | undefined {
    const request = this.editor.activeCommand.edit;
    if (request !== undefined) {
      this.constraintEdit = undefined;
      return { source: 'command', request };
    }
    const constraint = this.constraintEdit;
    if (constraint === undefined) return undefined;
    if (!this.editor.sketch.constraints.some((c) => c.id === constraint.constraint)) {
      this.constraintEdit = undefined;
      return undefined;
    }
    return {
      source: 'constraint',
      request: { at: constraint.at, value: constraint.value, label: { key: 'prompts.dimensionValue' } },
    };
  }

  /** Opens the box over the value text's anchor, pre-filled with the measurement. */
  private openEdit(request: EditRequest): void {
    const input = document.createElement('input');
    input.className = 'dimension-edit';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', this.t.t(request.label.key));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitEditBox();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelEditBox();
      }
    });
    // Blur applies the value, so clicking away from the box commits it. The
    // canvas takes focus on pointerdown, which is what blurs the box.
    input.addEventListener('blur', () => this.commitEditBox());
    input.addEventListener('input', () => (this.editDirty = true));
    input.value = this.t.number(request.value, 2);
    this.editInput = input;
    this.editDirty = false;
    const at = this.editor.viewport.toScreen(request.at);
    input.style.left = `${at.x}px`;
    input.style.top = `${at.y}px`;
    this.stage.append(input);
    input.select();
    input.focus();
  }

  /** Enter, or a blur: applies what the user typed. A rejection keeps the box open. */
  private commitEditBox(): void {
    const input = this.editInput;
    if (input === undefined) return;
    // The box belongs to a double-clicked dimension, so it re-values that
    // constraint; anything else belongs to the command that asked for it.
    if (this.editSource === 'constraint') {
      this.commitConstraintEdit(input);
      return;
    }
    const command = this.editor.activeCommand;
    if (command.commitEdit === undefined) return;
    // An unusable value or a solver rejection keeps the box open and focused,
    // so the user can fix it, exactly like the properties panel does.
    if (!command.commitEdit(input.value, this.editDirty)) {
      input.focus();
      input.select();
    }
  }

  /**
   * Applies what the user typed to the dimension the box is re-valuing, the way
   * the properties panel's value field does: the text is a parameter name or an
   * expression, and the editor commits it as one undo step. An unusable value,
   * or one the solver rejects, keeps the box open and focused so it can be fixed.
   */
  private commitConstraintEdit(input: HTMLInputElement): void {
    const edit = this.constraintEdit;
    if (edit === undefined) return;
    // Nothing typed: the value stands as it is, exactly like a command's box
    // accepts an untouched measurement — which keeps a bound parameter bound.
    if (!this.editDirty) {
      this.closeEdit();
      return;
    }
    const params = this.editor.sketch.params;
    const parsed = parseNumber(input.value, params);
    if (!parsed.ok) {
      // Unusable text: the same message the properties panel shows, and the box
      // stays open on the entry so it can be corrected.
      this.editor.setMessage({ key: 'properties.invalid' });
      input.setAttribute('aria-invalid', 'true');
      input.title = parsed.error;
      input.focus();
      input.select();
      return;
    }
    // A parameter's name binds the dimension to it; anything else stores the number.
    const name = input.value.trim();
    this.editor.setConstraintValue(edit.constraint, name in params ? name : parsed.value);
    // A re-solve the sketch does not survive leaves the constraint on its old
    // value, which is how the box learns the entry was refused. (The editor has
    // already reported why, so the box says nothing more.)
    const applied = this.editor.sketch.constraints.find((c) => c.id === edit.constraint);
    if (applied === undefined || constraintValue(applied, params) !== parsed.value) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      input.select();
      return;
    }
    // Applied, so the box is done. Closed here rather than left to the next
    // render: a value the sketch already holds commits nothing, and would then
    // leave the box open with nothing to close it.
    this.closeEdit();
  }

  /** Esc: drops the entry; the command steps back to placing the dimension. */
  private cancelEditBox(): void {
    // A double-click's box has no command to step back through, so it just closes.
    if (this.editSource === 'constraint') {
      this.closeEdit();
      return;
    }
    this.editor.activeCommand.cancelEdit?.();
  }

  private closeEdit(): void {
    const input = this.editInput;
    this.editInput = undefined;
    this.editDirty = false;
    this.editSource = undefined;
    this.constraintEdit = undefined;
    // The field is cleared before the element goes: removing a focused input
    // blurs it, and the blur handler must then find no box left to commit.
    input?.remove();
  }

  // 鈹€鈹€ Canvas input 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /** Where a canvas mouse event — a pointer, the wheel, a double-click — points, in both coordinate systems. */
  private input(event: MouseEvent): PointerInput {
    const rect = this.canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return {
      screen,
      world: this.editor.viewport.toWorld(screen),
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
      alt: event.altKey,
    };
  }

  /** The constraint whose symbol is under a world point, if symbols are shown. */
  private constraintAt(world: Vec2): Id | undefined {
    if (!settings.value.showConstraints) return undefined;
    const vp = this.editor.viewport;
    return hitConstraint(constraintPlacements(this.editor.sketch, vp.scale), world, 12 / vp.scale);
  }

  /** Pointer moves are coalesced to one per frame; a press or release flushes the pending one first. */
  private flushMove(): void {
    const input = this.pendingMove;
    this.pendingMove = undefined;
    if (input !== undefined) this.editor.activeCommand.pointerMove?.(input);
  }

  private bindCanvas(stage: HTMLElement): void {
    const { signal } = this.abort;
    const c = this.canvas;
    const vp = this.editor.viewport;

    new ResizeObserver(() => {
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Keep the view centered on the same world point.
      vp.panBy((rect.width - vp.width) / 2, (rect.height - vp.height) / 2);
      vp.resize(rect.width, rect.height);
      this.editor.viewChanged();
    }).observe(c);
    signal.addEventListener('abort', () => c.replaceChildren());

    c.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });

    // A double-click on a dimension re-values it in place, the way Inventor
    // edits one, opening the same inline box a command's value entry uses.
    c.addEventListener(
      'dblclick',
      (event) => {
        // The command's own box owns the value entry while it is open.
        if (this.editor.activeCommand.edit !== undefined) return;
        const input = this.input(event);
        const id = this.constraintAt(input.world);
        if (id === undefined) return;
        const constraint = this.editor.sketch.constraints.find((x) => x.id === id);
        // Only a dimension carries a value to re-enter; a miss, or any other
        // constraint, does nothing.
        if (constraint === undefined || !isDimensionKind(constraint.kind)) return;
        this.constraintEdit = {
          constraint: constraint.id,
          // Over the value text the dimension draws, so the box lands where the
          // user double-clicked; degenerate geometry falls back to the cursor.
          at: dimensionLayout(constraint, indexEntities(this.editor.sketch), vp.scale)?.textAt ?? input.world,
          value: constraintValue(constraint, this.editor.sketch.params) ?? 0,
        };
        this.schedule();
      },
      { signal },
    );

    c.addEventListener(
      'pointerdown',
      (event) => {
        this.editor.clearMessage();
        const input = this.input(event);
        if (event.button === 1) {
          event.preventDefault();
          this.pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
          c.setPointerCapture(event.pointerId);
          this.editor.viewChanged();
          return;
        }
        if (event.button === 2) {
          this.menuGesture = { pointer: event.pointerId, x: input.screen.x, y: input.screen.y };
          c.setPointerCapture(event.pointerId);
          this.menu.open(input.screen, this.menuItems());
          return;
        }
        if (event.button !== 0 || this.menu.isOpen) return;
        // Focusing here blurs the inline value box, which commits it: clicking
        // away from the box is "apply the value", so canvas input is not gated
        // while it is open. (The command ignores pointer input until then.)
        c.focus();
        c.setPointerCapture(event.pointerId);
        this.flushMove();
        // A constraint symbol under the cursor is picked before the geometry.
        const symbol = this.constraintAt(input.world);
        if (symbol !== undefined) {
          this.editor.select([symbol], event.shiftKey || event.ctrlKey ? 'toggle' : 'replace');
          return;
        }
        this.editor.activeCommand.pointerDown?.(input);
      },
      { signal },
    );

    c.addEventListener(
      'pointermove',
      (event) => {
        if (this.pan?.pointer === event.pointerId) {
          vp.panBy(event.clientX - this.pan.x, event.clientY - this.pan.y);
          this.pan = { ...this.pan, x: event.clientX, y: event.clientY };
          this.editor.viewChanged();
          return;
        }
        if (this.menuGesture !== undefined) return;
        const input = this.input(event);
        this.editor.setCursor(input.world);
        if (this.menu.isOpen) return;
        const idle = this.pendingMove === undefined;
        this.pendingMove = input;
        if (idle) requestAnimationFrame(() => this.flushMove());
      },
      { signal },
    );

    const release = (event: PointerEvent) => {
      if (c.hasPointerCapture(event.pointerId)) c.releasePointerCapture(event.pointerId);
      if (this.pan?.pointer === event.pointerId) {
        this.pan = undefined;
        this.editor.viewChanged();
        return;
      }
      if (this.menuGesture?.pointer === event.pointerId) {
        this.menuGesture = undefined;
        this.menu.gesture(this.input(event).screen);
        return;
      }
      if (event.button !== 0) return;
      this.flushMove();
      this.editor.activeCommand.pointerUp?.(this.input(event));
    };
    c.addEventListener('pointerup', release, { signal });
    c.addEventListener('pointercancel', release, { signal });

    c.addEventListener(
      'pointerleave',
      () => {
        if (this.pan !== undefined) return;
        this.editor.setCursor(undefined);
        this.editor.setHover(undefined);
      },
      { signal },
    );

    c.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
        vp.zoomAt(this.input(event).screen, WHEEL_ZOOM ** -delta);
        this.editor.setCursor(this.input(event).world);
      },
      { signal, passive: false },
    );

    // Keep the menu inside the stage when it is opened near an edge.
    stage.style.position = 'relative';
  }

  private menuItems(): MenuItem[] {
    const e = this.editor;
    const active = e.activeCommand;
    const items: MenuItem[] = [];
    if (active.id !== 'select') {
      items.push({ label: { key: 'commands.ok' }, icon: 'ok', enabled: true, run: () => e.finishCommand() });
    }
    items.push(...(active.menu?.() ?? []));
    const last = e.repeatable;
    items.push(
      {
        label: last === undefined ? { key: 'commands.cancel' } : { key: 'commands.repeat', params: { command: this.t.t(`commands.${last}` as never) } },
        icon: last === undefined ? 'cancel' : 'repeat',
        enabled: last !== undefined || active.id !== 'select',
        run: () => (last === undefined ? e.escape() : e.repeatLastCommand()),
      },
      { label: { key: 'commands.delete' }, icon: 'delete', enabled: e.selection.size > 0, run: () => e.deleteSelection() },
      { label: { key: 'commands.undo' }, icon: 'undo', enabled: e.history.canUndo, run: () => e.undo() },
      { label: { key: 'commands.zoomAll' }, icon: 'zoomAll', enabled: true, run: () => e.zoomAll() },
      {
        label: { key: 'commands.construction' },
        icon: 'construction',
        enabled: e.sketch.entities.some((x) => x.kind !== 'point' && e.selection.has(x.id)),
        run: () => e.toggleConstruction(),
      },
      {
        label: { key: 'commands.showConstraints' },
        icon: 'construction',
        enabled: true,
        run: () => settings.toggleShow(),
      },
      {
        label: { key: 'settings.label' },
        icon: 'fix',
        enabled: true,
        run: () => this.settingsDialog.open(document.activeElement instanceof HTMLElement ? document.activeElement : undefined),
      },
      {
        label: { key: 'parameters.label' },
        icon: 'mathFunction',
        enabled: true,
        run: () => this.parametersDialog.open(document.activeElement instanceof HTMLElement ? document.activeElement : undefined),
      },
    );
    return items;
  }

  // 鈹€鈹€ Keyboard 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  private bindKeyboard(): void {
    document.addEventListener('keydown', (event) => this.onKey(event), { signal: this.abort.signal });
  }

  private onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || this.menu.isOpen || this.appMenu.isOpen) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      return;
    }
    const e = this.editor;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    e.clearMessage();

    if (e.activeCommand.keyDown?.(event) === true) {
      event.preventDefault();
      return;
    }

    if (key === 'Escape') {
      event.preventDefault();
      this.aliases.reset();
      e.escape();
      return;
    }
    if (ctrl && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'z' && !event.shiftKey) {
        event.preventDefault();
        e.undo();
      } else if (lower === 'y' || (lower === 'z' && event.shiftKey)) {
        event.preventDefault();
        e.redo();
      }
      return;
    }
    if (event.altKey) return;
    if (key === 'Delete') {
      event.preventDefault();
      e.deleteSelection();
      return;
    }
    // Inventor: F8 shows all constraints, F9 hides them.
    if (key === 'F8' || key === 'F9') {
      event.preventDefault();
      settings.setShow(key === 'F8');
      this.canvas.focus();
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      e.zoomAll();
      return;
    }
    // Enter/Space activate focused controls; on the canvas they confirm a typed alias or repeat.
    const onControl = target instanceof HTMLButtonElement || (target instanceof HTMLElement && target.closest('[role="tree"]') !== null);
    if ((key === 'Enter' || key === ' ') && !onControl) {
      event.preventDefault();
      if (!this.aliases.flush()) e.repeatLastCommand();
      return;
    }
    if (key.length === 1 && !onControl && this.aliases.feed(key)) {
      event.preventDefault();
    }
  }
}
