import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function changelogSections(root) {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^## \[([^\]\r\n]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/gm)];
  return headings.map((h, i) => ({
    version: h[1], date: h[2],
    body: text.slice(h.index + h[0].length, headings[i + 1]?.index).trim(),
    text: text.slice(h.index, headings[i + 1]?.index).trim() + '\n',
  }));
}

export function requireNotes(section, version) {
  if (!section || section.version !== version || !section.date) throw new Error(`CHANGELOG.md needs a dated section for ${version}.`);
  if (!section.body.replace(/^#+.*$/gm, '').trim()) throw new Error(`CHANGELOG.md has empty release notes for ${version}.`);
  return section.text;
}

export function releaseNotes(root, version) {
  return requireNotes(changelogSections(root).find(s => s.version === version), version);
}
