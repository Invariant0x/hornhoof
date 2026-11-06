#!/usr/bin/env node
// A program that keeps a screen of its own, as the terminal programs do: rows at the bottom it redraws at each size, and
// the cursor two rows above the last. argv: normal (its lines go into the pane's history), alternate (it keeps them to
// itself on the alternate screen), last-row (normal, with the cursor on the last row, as a shell). Keys: n adds a line,
// r redraws the screen.
const kind = process.argv[2] ?? 'normal';
const out = text => process.stdout.write(text);
const rows = () => process.stdout.rows || 24;
const at = (row, col = 1) => `\x1b[${row};${col}H`;
const lines = Array.from({ length: 200 }, (_, at) => `line-${at + 1}-end`);
let added = 0;

const promptRow = () => (kind === 'last-row' ? rows() : rows() - 2);
const bottom = () => (kind === 'last-row'
  ? `${at(rows())}\x1b[2K$ `
  : `${at(rows() - 3)}\x1b[2K${'-'.repeat(20)}${at(rows() - 2)}\x1b[2K> ${at(rows() - 1)}\x1b[2K${'-'.repeat(20)}${at(rows())}\x1b[2Kfooter`);
const cursor = () => at(promptRow(), 3);
const shown = () => {
  const top = rows() - 5;
  let text = '';
  for (let row = 1; row <= top; row++) text += `${at(row)}\x1b[2K${lines[lines.length - top + row - 1] ?? ''}`;
  return text;
};
const draw = () => out((kind === 'alternate' ? shown() : '') + bottom() + cursor());

function addLine() {
  const line = `new-${++added}-end`;
  if (kind === 'alternate') {
    lines.push(line);
    return draw();
  }
  out(kind === 'last-row' ? `${at(rows())}\x1b[2K${line}\r\n$ ` : `${at(rows())}\n${at(rows() - 5)}\x1b[2K${line}${bottom()}${cursor()}`);
}

process.stdin.setRawMode?.(true);
process.stdin.on('data', keys => {
  for (const key of String(keys)) {
    if (key === 'n') addLine();
    if (key === 'r') draw();
  }
});
if (kind === 'alternate') out('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J');
else out(`${lines.join('\r\n')}\r\n${kind === 'last-row' ? '' : '\r\n'.repeat(rows())}`);
draw();
/* After the first write: the size is new only after process.stdout's own listener, which that write adds. */
process.on('SIGWINCH', draw);
setInterval(() => {}, 1 << 30);
