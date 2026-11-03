import { appendFileSync } from 'node:fs';
import { rawKeys, readKeys } from './keys.mjs';

rawKeys();
readKeys(key => {
  appendFileSync(process.argv[2], JSON.stringify(key) + '\n');
  if (key === 'enter') process.stdout.write('received\n');
});
process.stdout.write('ready\n');
