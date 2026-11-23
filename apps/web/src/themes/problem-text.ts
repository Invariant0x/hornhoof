/* What the theme store says of an archive the server refused (docs/theme-archive.md, 10): the problem's own words with
   the file it is in, then what the check found there. For a look, that is the skin check's own words, as a skin file
   would get them. */

import type { ThemeProblem } from '@hornhoof/protocol/themes';
import type { Messages } from '../i18n/en';

export function archiveProblemText(t: Messages, problem: ThemeProblem): string {
  const words = t.skins.archive.problems;
  const text = (words[problem.code] ?? words.zip_corrupt)(problem.path ?? '');
  if (!problem.detail) return text;
  return problem.code === 'look_bad' ? lookProblemText(t, text, problem.detail) : `${text} (${problem.detail})`;
}

/* A look: the skin check's words for what it found; as it is, when the check names a problem with no words; none,
   when it cannot be read. */
function lookProblemText(t: Messages, text: string, detail: string): string {
  const said = skinCheckSaid(t, detail);
  if (said === null) return text;
  return said === undefined ? `${text} (${detail})` : `${text} ${said}`;
}

function skinCheckSaid(t: Messages, detail: string): string | null | undefined {
  try {
    const [code, key, value] = JSON.parse(detail) as [keyof Messages['skins']['errors'], string, string];
    return t.skins.errors[code]?.(key, value);
  } catch {
    return null;
  }
}
