import type { ReactNode } from 'react';

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/* **bold** and `code`; everything else stays text, so nothing an agent writes becomes markup. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) {
      out.push({ kind: 'p', lines: [] });
      continue;
    }
    const kind = BULLET.test(raw) ? 'ul' : NUMBER.test(raw) ? 'ol' : 'p';
    const line = kind === 'ul' ? raw.replace(BULLET, '') : kind === 'ol' ? raw.replace(NUMBER, '') : HEADING.test(raw) ? `**${raw.replace(HEADING, '')}**` : raw;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.lines.length) last.lines.push(line);
    else out.push({ kind, lines: [line] });
  }
  return out.filter(b => b.lines.length);
}

/* An agent's answer the way Claude Code shows it: paragraphs, lists, bold and code. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) => {
        if (b.kind === 'p')
          return (
            <p key={i}>
              {b.lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {inline(l)}
                </span>
              ))}
            </p>
          );
        const items = b.lines.map((l, j) => <li key={j}>{inline(l)}</li>);
        return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}
