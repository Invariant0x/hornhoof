// A terminal program leaves its alternate screen before exiting, as the real TUIs do.
export function crash(mode = '') {
  process.stdout.write('\x1b[?1049h');
  if (mode === 'long') process.stdout.write('x'.repeat(350000) + '\n');
  for (let i = 0; i < 60; i++) process.stdout.write(`output ${i}\n`);
  if (mode === 'login') process.stderr.write('not logged in. Run /login or /provider to get started.\n');
  process.stderr.write(`boom ${process.env.FAKE_SECRET}\n\n\n`);
  process.stdout.write('\x1b[?1049l');
  process.exit(3);
}
