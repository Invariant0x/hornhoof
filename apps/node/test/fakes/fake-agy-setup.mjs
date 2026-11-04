// Plays agy 1.4.12's first-run setup from the screens recorded in fixtures/agy-tui: the colors, where Enter takes the
// scheme and goes on, then its terms, where every key is kept in FAKE_LOG. agy shows it until its settings.json says
// consumerOnboardingComplete; Done (Down twice, then Enter) writes that, as a person who accepts the terms does, and a
// second Ctrl+C closes agy with nothing saved.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const file = () => join(process.env.HOME, '.gemini', 'antigravity-cli', 'settings.json');
const screen = name => readFileSync(new URL(`../fixtures/agy-tui/screen-setup-${name}.ansi`, import.meta.url), 'utf8').trimEnd();
const trace = data => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(data) + '\n');
};
const NAMES = { '\r': 'enter', '\x1b[A': 'up', '\x1b[B': 'down', '\x03': 'ctrl-c' };

function settings() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

/* Resolves once the setup is passed, at once when it was passed before. */
export function firstRun() {
  if (settings().consumerOnboardingComplete === true) return Promise.resolve();
  return new Promise(resolve => {
    let step = 'colors';
    /* On the terms: 0 the box, 1 Previous, 2 Done. */
    let focus = 0;
    let quitting = false;
    const show = () => process.stdout.write(`\x1b[0m\x1b[2J\x1b[H${screen(step)}\x1b[0m`);
    const press = key => {
      trace({ setup: step, key });
      if (key === 'ctrl-c' && quitting) process.exit(0);
      quitting = key === 'ctrl-c';
      if (step === 'colors') {
        if (key === 'enter') step = 'terms';
      } else if (key === 'down' || key === 'up') focus = Math.max(0, Math.min(2, focus + (key === 'down' ? 1 : -1)));
      else if (key === 'enter' && focus === 1) step = 'colors';
      else if (key === 'enter' && focus === 2) return done();
      show();
    };
    const done = () => {
      step = null;
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify({ ...settings(), consumerOnboardingComplete: true }, null, 2) + '\n');
      process.stdin.off('data', read);
      resolve();
    };
    const read = data => {
      for (const key of data.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) if (step) press(NAMES[key] ?? key);
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', read);
    show();
  });
}
