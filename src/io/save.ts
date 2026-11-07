/**
 * Saving text to a file. Where the browser has the File System Access API the picker chooses a
 * location once and every later save overwrites that same file; everywhere else each save is a
 * download. The DOM is only touched when a save runs, so this module imports cleanly under Node
 * (where `window` and `document` are absent) and stays testable.
 */

/** The picker's options, as far as this module uses them. */
interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

/**
 * The File System Access API's picker. The DOM lib declares the handles it returns but not the
 * picker itself, so the one function is declared here and reached through a cast — browsers without
 * it simply lack the property.
 */
interface SavePickerWindow {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}

export interface FileSaver {
  /** Saves `text` under `filename`; resolves to the name actually used. */
  save(filename: string, mime: string, text: string): Promise<string>;
  /** True when a previous save picked a real location, so later saves overwrite it. */
  readonly hasLocation: boolean;
}

/** The picker's `accept` map for a filename: its own extension, keyed by mime type. */
function acceptMap(filename: string, mime: string): Record<string, readonly string[]> {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot) : '';
  return { [mime]: extension === '' ? [] : [extension] };
}

/** The classic fallback: a Blob URL and a temporary `<a download>`. */
function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** True when the user dismissed the picker rather than a real failure. */
function dismissed(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Creates a saver remembering the location its first save picked. */
export function createFileSaver(): FileSaver {
  let handle: FileSystemFileHandle | undefined;

  return {
    async save(filename, mime, text) {
      const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
      if (picker !== undefined) {
        if (handle === undefined) {
          try {
            handle = await picker.call(window, {
              suggestedName: filename,
              types: [{ description: mime, accept: acceptMap(filename, mime) }],
            });
          } catch (error) {
            if (dismissed(error)) return '';
            throw error;
          }
        }
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return filename;
      }
      download(filename, mime, text);
      return filename;
    },

    get hasLocation() {
      return handle !== undefined;
    },
  };
}
