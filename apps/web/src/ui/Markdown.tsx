import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

type Block = { kind: 'p' | 'ul' | 'ol' | 'h2' | 'h3' | 'code'; lines: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const H3 = /^\s*#{3,6}\s+/;
const HEADING = /^\s*#{1,2}\s+/;
const FENCE = /^\s*```/;
const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^)\s]+\))/;
const LINK_TOKEN = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const isBoldToken = (part: string) => part.length > 4 && part.startsWith('**') && part.endsWith('**');
const isCodeToken = (part: string) => part.length > 2 && part.startsWith('`') && part.endsWith('`');

function safeMarkdownHref(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function renderLinkToken(part: string, key: number): ReactNode {
  const match = LINK_TOKEN.exec(part);
  if (!match) return part;
  const href = safeMarkdownHref(match[2]!);
  if (!href) return part;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {match[1]}
    </a>
  );
}

/* **bold**, `code`, and approved [label](https://...) links; everything else stays text, so nothing an agent writes becomes markup. */
function inlineToken(part: string, key: number): ReactNode {
  if (isBoldToken(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
  if (isCodeToken(part)) return <code key={key}>{part.slice(1, -1)}</code>;
  return renderLinkToken(part, key);
}

const inline = (text: string): ReactNode[] => text.split(INLINE_SPLIT).map(inlineToken);

function classifyListOrParagraph(raw: string): { kind: 'p' | 'ul' | 'ol'; line: string } {
  if (BULLET.test(raw)) return { kind: 'ul', line: raw.replace(BULLET, '') };
  if (NUMBER.test(raw)) return { kind: 'ol', line: raw.replace(NUMBER, '') };
  return { kind: 'p', line: raw };
}

function classifyLine(raw: string): { kind: 'p' | 'ul' | 'ol' | 'h2' | 'h3'; line: string } {
  if (H3.test(raw)) return { kind: 'h3', line: raw.replace(H3, '') };
  if (HEADING.test(raw)) return { kind: 'h2', line: raw.replace(HEADING, '') };
  return classifyListOrParagraph(raw);
}

function mergeOrPushBlock(out: Block[], kind: 'p' | 'ul' | 'ol', line: string) {
  const last = out[out.length - 1];
  if (last && last.kind === kind && last.lines.length) last.lines.push(line);
  else out.push({ kind, lines: [line] });
}

function appendClassifiedBlock(out: Block[], raw: string) {
  if (!raw.trim()) {
    out.push({ kind: 'p', lines: [] });
    return;
  }
  const { kind, line } = classifyLine(raw);
  if (kind === 'h2' || kind === 'h3') {
    out.push({ kind, lines: [line] });
    return;
  }
  mergeOrPushBlock(out, kind, line);
}

function toggleFence(out: Block[], codeLines: string[] | null): string[] | null {
  if (!codeLines) return [];
  out.push({ kind: 'code', lines: codeLines });
  return null;
}

function stepMarkdownLine(out: Block[], codeLines: string[] | null, raw: string): string[] | null {
  if (FENCE.test(raw)) return toggleFence(out, codeLines);
  if (codeLines) {
    codeLines.push(raw);
    return codeLines;
  }
  appendClassifiedBlock(out, raw);
  return null;
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let codeLines: string[] | null = null;
  for (const raw of text.split('\n')) codeLines = stepMarkdownLine(out, codeLines, raw);
  if (codeLines) out.push({ kind: 'code', lines: codeLines });
  return out.filter(b => b.lines.length > 0);
}

function renderListOrParagraph(b: Block, key: number): ReactNode {
  if (b.kind === 'p') {
    return (
      <p key={key}>
        {b.lines.map((l, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {inline(l)}
          </span>
        ))}
      </p>
    );
  }
  const items = b.lines.map((l, j) => <li key={j}>{inline(l)}</li>);
  return b.kind === 'ul' ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
}

function renderBlock(b: Block, key: number): ReactNode {
  if (b.kind === 'code') return <pre key={key}><code>{b.lines.join('\n')}</code></pre>;
  if (b.kind === 'h2') return <h2 key={key}>{inline(b.lines[0]!)}</h2>;
  if (b.kind === 'h3') return <h3 key={key}>{inline(b.lines[0]!)}</h3>;
  return renderListOrParagraph(b, key);
}

/* An agent's answer or Markdown material: headings, paragraphs, lists, fenced code, bold, inline code, and safe links. */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text).map(renderBlock)}</div>;
}

/* End the excerpt at a word or an entire inline token so links and formatting stay intact. */
function previewLine(line: string, room: number): string {
  let preview = '';
  for (const [i, part] of line.split(INLINE_SPLIT).entries()) {
    const words = i % 2 === 1 ? [part] : part.match(/\S+\s*|\s+/g) ?? [];
    for (const word of words) {
      if (preview.length + word.trimEnd().length > room) return preview.trimEnd();
      preview += word;
    }
  }
  return preview.trimEnd();
}

function previewBlocks(content: Block[]): Block[] {
  const preview: Block[] = [];
  let rows = 3;
  let room = 160;
  for (const block of content) {
    const lines: string[] = [];
    preview.push({ kind: block.kind, lines });
    for (const line of block.lines) {
      if (!rows || room <= 0) return preview.filter(b => b.lines.length);
      if (line.length > room) {
        const first = block.kind === 'code' ? '' : previewLine(line, room);
        if (first) lines.push(first);
        return preview.filter(b => b.lines.length);
      }
      lines.push(line);
      rows--;
      room -= line.length;
    }
  }
  return content;
}

export function FoldedMarkdown({ text }: { text: string }) {
  const t = useT();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const content = blocks(text);
  const preview = previewBlocks(content);
  if (!content.length) return null;

  return (
    <div className="tp-body">
      <div className="md" id={id} dir="auto">{(expanded ? content : preview).map(renderBlock)}</div>
      {preview !== content && (
        <button className="t-link tp-disclosure" type="button" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t.tasks.showLess : t.tasks.moreDescription}
        </button>
      )}
    </div>
  );
}
