// Reads only the two authorized startup AGENTS documents; never prints their text.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { orchestratorSteady } from '../apps/server/src/modules/agents/instructions.ts';
import { loadTemplates, textHash } from '../apps/server/src/modules/templates/load.ts';

const steady = orchestratorSteady(loadTemplates('templates'));
const paths = [
  '/data/home/sessions/2026/11/01/rollout-2026-11-01T00-17-30-01a19477-f012-7233-a712-0c9049920301.jsonl',
  '/data/home/sessions/2026/11/01/rollout-2026-11-01T00-28-53-01a19482-5c46-79e1-bd6e-14a41099f907.jsonl',
];

function agentsDocument(line) {
  if (!/"type"\s*:\s*"response_item"/.test(line.slice(0, 220))) return null;
  const entry = JSON.parse(line);
  if (entry.payload?.type !== 'message' || entry.payload.role !== 'user') return null;
  const doc = (entry.payload.content ?? []).filter(part => part.type === 'input_text').map(part => part.text ?? '').join('\n');
  return doc.startsWith('# AGENTS.md instructions for ') ? { doc, recordTimestamp: entry.timestamp } : null;
}

async function matchStartup(path) {
  const input = createReadStream(path, { highWaterMark: 4096 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      if (++lineNumber > 20) throw new Error('AGENTS document absent from narrow startup range');
      const document = agentsDocument(line);
      if (!document) continue;
      return { path, line: lineNumber, recordTimestamp: document.recordTimestamp, containsExactCurrentSteadyBeforeNotebook: document.doc.includes(`${steady}\n\n## Company notebook`) };
    }
  } finally {
    lines.close();
    input.destroy();
  }
  throw new Error('Missing AGENTS document');
}

const documents = [];
for (const path of paths) documents.push(await matchStartup(path));
console.log(JSON.stringify({
  sourceCommit: 'bd696b0724385b6b11da53a24ada2f188b031217',
  steadyCharacters: steady.length,
  steadyHash: textHash(steady),
  selectedModelHash: textHash(`${textHash(steady)}:gpt-6.1-sol`),
  hashAlgorithm: 'sha256 hex first 12 characters, templates/load.ts:80',
  documents,
  limitation: 'Source candidates plus AGENTS content match. Actual DB job hashes remain unavailable. Requires the two authorized source files in this environment.',
}, null, 2));
