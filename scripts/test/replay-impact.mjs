import { readFileSync } from 'node:fs';
import { runImpactReplay, replayExitCode } from '../../apps/node/dist/test-impact-replay-cli.js';

/* Build protocol/node first. Request280/222 and native comparator fetching remain caller ports. */
try {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const report = await runImpactReplay(process.cwd(), request);
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = replayExitCode(report);
} catch {
  process.stderr.write('impact_replay_failed\n');
  process.exitCode = 1;
}
