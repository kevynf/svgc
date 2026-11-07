import { en } from './en';
import { isPlural } from './types';
import type { Catalog, Leaf, MessageKey, MessageTree } from './types';
import { zhCN } from './zh-CN';
import type { Messages } from './zh-CN';

export type Locale = 'zh-CN' | 'en';
export type Key = MessageKey<Messages>;
export type Params = Readonly<Record<string, string | number>>;

export const LOCALES: readonly { readonly id: Locale; readonly name: string }[] = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'en', name: 'English' },
];

const catalogs: Record<Locale, Catalog<Messages>> = { 'zh-CN': zhCN, en };

export const DEFAULT_LOCALE: Locale = 'zh-CN';

function lookup(tree: MessageTree, key: string): Leaf | undefined {
  let node: Leaf | MessageTree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string' || isPlural(node)) return undefined;
    node = node[part];
  }
  return node === undefined || (typeof node === 'object' && !isPlural(node)) ? undefined : node;
}

function interpolate(template: string, params: Params, format: (n: number) => string): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? format(value) : value;
  });
}

/**
 * A translator bound to one locale. Missing keys fall back to the default locale, then to the key
 * itself.
 */
export class Translator {
  readonly locale: Locale;
  private readonly plurals: Intl.PluralRules;
  private readonly numbers: Intl.NumberFormat;

  constructor(locale: Locale) {
    this.locale = locale;
    this.plurals = new Intl.PluralRules(locale);
    this.numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  }

  t(key: Key, params: Params = {}): string {
    const leaf = lookup(catalogs[this.locale], key) ?? lookup(catalogs[DEFAULT_LOCALE], key);
    if (leaf === undefined) return key;
    let template: string;
    if (typeof leaf === 'string') {
      template = leaf;
    } else {
      const count = params['count'];
      const category = typeof count === 'number' ? this.plurals.select(count) : 'other';
      template = leaf[category] ?? leaf.other;
    }
    return interpolate(template, params, (n) => this.numbers.format(n));
  }

  number(value: number, fractionDigits = 2): string {
    return new Intl.NumberFormat(this.locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  }
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.id === value);
}

/** Every leaf key present in a catalog, for completeness checks. */
export function catalogKeys(tree: MessageTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([name, node]) => {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    return typeof node === 'string' || isPlural(node) ? [key] : catalogKeys(node, key);
  });
}

export const catalogsForTest = catalogs;
