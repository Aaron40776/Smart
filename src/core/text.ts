/**
 * Text from a model, or from your files (a diff), is shown in your terminal. Escape sequences in it would be executed by the
 * terminal, not shown: a prompt-injected reply could retitle the window, rewrite what is on screen, or (OSC 52) put text on
 * your clipboard. `forTerminal` removes them, and every other control character except newline and tab.
 */
// Built from strings so the source holds no raw control characters (and ESLint's no-control-regex stays on elsewhere).
const ESC = '\\u001b';
const SEQUENCES = new RegExp(
  [
    `${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)?`, // OSC ... BEL / ST (window title, clipboard, hyperlinks)
    `${ESC}[P^_X][^\\u001b]*(?:${ESC}\\\\)?`, // DCS, PM, APC, SOS strings
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI (colours, cursor movement, erase)
    `${ESC}[ -/]*[0-~]`, // other two-character escapes
    '\\u009b[0-?]*[ -/]*[@-~]', // 8-bit CSI
  ].join('|'),
  'g',
);
/** C0 and C1 control characters and DEL, except tab (9) and newline (10). */
const isControl = (code: number): boolean => (code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f);

export function forTerminal(text: string): string {
  const stripped = text.replace(/\r\n/g, '\n').replace(SEQUENCES, '');
  let out = '';
  for (const ch of stripped) if (!isControl(ch.charCodeAt(0))) out += ch;
  return out;
}

/** One line of model text for a label (a plan title, a reason): no control characters, no line breaks, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const t = forTerminal(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Model text kept as paragraphs (instructions, an answer), cleaned and capped. */
export function block(text: string, max: number): string {
  const t = forTerminal(text).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
