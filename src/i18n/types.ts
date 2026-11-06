/** A message whose wording depends on a `count` parameter (CLDR plural categories). */
export interface Plural {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Leaf = string | Plural;

export interface MessageTree {
  readonly [key: string]: Leaf | MessageTree;
}

export function plural(forms: Plural): Plural {
  return forms;
}

export function isPlural(value: Leaf | MessageTree): value is Plural {
  return typeof value === 'object' && typeof value['other'] === 'string';
}

/** Dotted paths to every leaf of a message tree, e.g. `'status.fullyConstrained'`. */
export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends Leaf ? K : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];

/** Same shape as `T`, with every leaf widened to `string | Plural`. */
export type Catalog<T> = {
  readonly [K in keyof T]: T[K] extends Leaf ? Leaf : Catalog<T[K]>;
};
