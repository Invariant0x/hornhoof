import { main } from './author-check/main.mjs';
import { wiredPorts } from './author-check/wired.mjs';

/* See .hornhoof/author-check.md. */
try {
  process.exitCode = await main(process.argv.slice(2), process.env, wiredPorts(process.cwd()));
} catch (error) {
  process.stderr.write(`author_check_broken: ${error.stack ?? error}\n`);
  process.exitCode = 2;
}
