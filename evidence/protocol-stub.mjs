export const TAIL_BYTES = 4096;
export const TERM_CHUNK = 64 * 1024;
export const API_MODELS = { anthropic_api: [], openai_api: [] };
export const CLAUDE_ALIASES = [];
export const PROVIDER_IDS = [];

export function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function repoFolder(url) {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? '';
  return last.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'repo';
}
