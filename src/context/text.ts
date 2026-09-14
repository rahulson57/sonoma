/** Small, deterministic text helpers for the rendered context. No locale, no Intl. */

/** True when `text` contains a C0 control character or DEL. */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Single-line identifiers (paths, ids, labels) containing control characters are shown JSON-quoted. */
export function printable(text: string): string {
  return hasControlChars(text) ? JSON.stringify(text) : text;
}

/** UTF-16 code unit order, independent of locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
