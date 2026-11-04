#!/usr/bin/env node
// Plays Antigravity CLI 1.4.12 for a person who is not signed in, for the sign-in tests: the screens recorded from agy in
// a container. Enter picks Google OAuth and shows Google's link; the code "good-code" signs in, any other gets Google's
// answer to a wrong code; what agy shows once signed in was not recorded, so the screen is left empty. `agy models` answers
// as agy does, signed in or not. Started signed in, it shows its first-run setup where the test turned it on and nobody
// passed it, then its prompt.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstRun } from './fake-agy-setup.mjs';

const LINK =
  'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com' +
  '&code_challenge=FAKE-challenge&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback' +
  '&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email' +
  '+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+openid&state=FAKE-state';

const signedIn = join(process.env.HOME ?? '/tmp', 'fake-signed-in');

if (process.argv[2] === 'models') {
  if (existsSync(signedIn)) {
    process.stdout.write('Fetching available models...\ngemini-4-argon-high       Gemini 4 Argon (High)\n');
    process.exit(0);
  }
  process.stdout.write('Fetching available models...\n');
  process.stderr.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
  process.exit(1);
}

if (existsSync(signedIn)) {
  await firstRun();
  process.stdout.write(`\x1b[2J\x1b[H${readFileSync(new URL('../fixtures/agy-tui/screen-idle.ansi', import.meta.url), 'utf8')}`);
  process.stdin.resume();
} else signIn();

function signIn() {
  const LOGO = '     ▄▀▀▄\n    ▀▀▀▀▀▀\n   ▀▀▀▀▀▀▀▀\n  ▄▀▀    ▀▀▄\n ▄▀▀      ▀▀▄\n\n';
  const show = text => process.stdout.write(`\x1b[2J\x1b[H${LOGO}${text}`);

  let screen = 'methods';
  let code = '';
  show(' Welcome to the Antigravity CLI. You are currently not signed in.\n Select login method:\n > 1. Google OAuth\n   2. Use a Google Cloud project\n\n   ↑/↓ Navigate · enter Select\n');
  process.stdin.setRawMode(true);
  process.stdin.on('data', chunk => {
    for (const key of chunk.toString()) {
      if (screen === 'methods' && key === '\r') {
        screen = 'code';
        show(` Your browser should open automatically. If not:\n ${LINK}\n\n If you aren't automatically redirected, paste the authorization code below:\n authorization code...\n\n  shift+up/down Navigate\n`);
      } else if (screen === 'code' && key === '\r') {
        screen = 'done';
        if (code === 'good-code') {
          writeFileSync(signedIn, '');
          show('');
        } else show(' Got an error: token exchange failed: oauth2: "invalid_grant" "Bad Request"\n Press any key to go back.\n\n  shift+up/down Navigate\n');
      } else if (screen === 'code') code += key;
    }
  });
}
