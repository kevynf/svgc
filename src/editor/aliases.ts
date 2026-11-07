/**
 * Recognizes typed command aliases such as `L`, `REC` or `A3`. An alias fires
 * as soon as it is unambiguous; when it is also the prefix of a longer alias
 * (`A` vs `A3`) it fires after a short pause unless more keys arrive.
 */
export class AliasMatcher {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly aliases: ReadonlyMap<string, string>;

  constructor(
    aliases: Iterable<readonly [alias: string, command: string]>,
    private readonly fire: (command: string) => void,
    private readonly delayMs = 500,
  ) {
    this.aliases = new Map([...aliases].map(([alias, command]) => [alias.toUpperCase(), command]));
  }

  /** Feeds one typed character. Returns true when it was part of an alias. */
  feed(char: string): boolean {
    const key = char.toUpperCase();
    this.clearTimer();
    let candidate = this.buffer + key;
    if (!this.hasPrefix(candidate)) {
      candidate = key;
      if (!this.hasPrefix(candidate)) {
        this.buffer = '';
        return false;
      }
    }
    this.buffer = candidate;
    const command = this.aliases.get(candidate);
    const longer = [...this.aliases.keys()].some(
      (a) => a.length > candidate.length && a.startsWith(candidate),
    );
    if (command !== undefined && !longer) {
      this.reset();
      this.fire(command);
    } else if (command !== undefined) {
      this.timer = setTimeout(() => {
        this.reset();
        this.fire(command);
      }, this.delayMs);
    }
    return true;
  }

  /** Fires a complete pending alias immediately (Enter/Space). Returns true if one fired. */
  flush(): boolean {
    const command = this.aliases.get(this.buffer);
    this.reset();
    if (command === undefined) return false;
    this.fire(command);
    return true;
  }

  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.clearTimer();
    this.buffer = '';
  }

  private hasPrefix(text: string): boolean {
    for (const alias of this.aliases.keys()) {
      if (alias.startsWith(text)) return true;
    }
    return false;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
