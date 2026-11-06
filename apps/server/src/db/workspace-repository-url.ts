/* Storage identity only. A canonical URL is neither repository access nor an integration plan. */
export function canonicalWorkspaceRepositoryUrl(value: string): string | null {
  const url = repositoryUrl(value);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!path || path === '/') return null;
  url.username = ''; url.password = '';
  url.pathname = path;
  return url.href;
}

function repositoryUrl(value: string): URL | null {
  if (!/^https:\/\/[^/]/i.test(value) || /[\u0000-\u0020\u007f\\?#]/.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}
