import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function sectionHeading(text) {
  const match = /^## \[([^\]\r\n]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/.exec(text);
  if (!match) throw new Error(`CHANGELOG.md has a malformed release heading: ${text}`);
  return { version: match[1], date: match[2] };
}

export function changelogSections(root) {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^##(?!#)[^\n]*$/gm)];
  return headings.map((h, i) => ({
    ...sectionHeading(h[0]),
    body: text.slice(h.index + h[0].length, headings[i + 1]?.index).trim(),
    text: text.slice(h.index, headings[i + 1]?.index).trim() + '\n',
  }));
}

/* A release's notes are one short list in English: one-line entries under Fixed, Added and Changed, in that order,
   each kind once and with entries, with no summary, no other section and no translation. */
const KINDS = ['Fixed', 'Added', 'Changed'];
const ENTRY = /^- \S/;
const OTHER_SCRIPT = /(?!\p{Script=Latin})\p{L}/u;

function headingProblem(name, state) {
  const at = KINDS.indexOf(name);
  if (at < 0) return `may only have ### Fixed, ### Added and ### Changed, not "### ${name}"`;
  if (state.at >= 0 && !state.entries) return `has no entries under ### ${KINDS[state.at]}`;
  if (at <= state.at) return `has ### ${name} after ### ${KINDS[state.at]}; the list goes Fixed, Added, Changed, each once`;
  return null;
}

function lineProblem(line, state) {
  const text = line.trim();
  if (state.at < 0) return `are one list with no summary: "${text}" stands above ### Fixed, ### Added or ### Changed`;
  if (!ENTRY.test(line)) return `give each entry one line starting with "- ": "${text}" is not one`;
  if (OTHER_SCRIPT.test(text)) return `are in English only: "${text.slice(2)}" has letters of another script`;
  return null;
}

function listProblem(body) {
  const state = { at: -1, entries: 0 };
  for (const line of body.split('\n').filter(l => l.trim())) {
    const heading = /^###\s+(.*?)\s*$/.exec(line);
    const problem = heading ? headingProblem(heading[1], state) : lineProblem(line, state);
    if (problem) return problem;
    if (heading) Object.assign(state, { at: KINDS.indexOf(heading[1]), entries: 0 });
    else state.entries += 1;
  }
  return state.entries ? null : `has no entries under ### ${KINDS[state.at]}`;
}

export function requireNotes(section, version) {
  if (!section || section.version !== version || !section.date) throw new Error(`CHANGELOG.md needs a dated section for ${version}.`);
  if (!section.body.replace(/^#+.*$/gm, '').trim()) throw new Error(`CHANGELOG.md has empty release notes for ${version}.`);
  const problem = listProblem(section.body);
  if (problem) throw new Error(`CHANGELOG.md notes for ${version} ${problem}.`);
  return section.text;
}

export function releaseNotes(root, version) {
  return requireNotes(changelogSections(root).find(s => s.version === version), version);
}
