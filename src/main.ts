import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { demoSketch } from './demo';
import { CircleCommand, LineCommand, PointCommand, RectangleCommand } from './editor/commands/draw';
import { SelectCommand } from './editor/commands/select';
import { Editor } from './editor/editor';
import type { CommandFactory } from './editor/editor';
import { DEFAULT_LOCALE, isLocale, Translator } from './i18n/i18n';
import type { Locale } from './i18n/i18n';
import { createSolver } from './solver/solver';
import { App } from './ui/app';
import './style.css';

const LOCALE_KEY = 'svgc.locale';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('Missing #app');

function storedLocale(): Locale {
  const value = localStorage.getItem(LOCALE_KEY);
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

const commands = new Map<string, CommandFactory>([
  ['select', (editor) => new SelectCommand(editor)],
  ['line', (editor) => new LineCommand(editor)],
  ['circle', (editor) => new CircleCommand(editor)],
  ['rectangle', (editor) => new RectangleCommand(editor)],
  ['point', (editor) => new PointCommand(editor)],
]);

const solver = await createSolver(wasmUrl);
window.addEventListener('pagehide', () => solver.dispose());

const editor = new Editor(solver, demoSketch(), commands, 'select');
let app: App | undefined;

function start(locale: Locale): void {
  const fit = app === undefined;
  app?.dispose();
  const t = new Translator(locale);
  document.documentElement.lang = locale;
  document.title = t.t('app.title');
  app = new App({
    editor,
    t,
    onLocaleChange: (next) => {
      localStorage.setItem(LOCALE_KEY, next);
      start(next);
    },
  });
  app.mount(root!, fit);
}

start(storedLocale());
