export function AgentIcon({ label }: { label?: string }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <rect x="6" y="6" width="4" height="4" />
      <path d="M6 1v2M10 1v2M6 13v2M10 13v2M1 6h2M1 10h2M13 6h2M13 10h2" />
    </svg>
  );
}

export function PersonIcon({ label }: { label?: string }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="8" cy="5.2" r="2.9" />
      <path d="M2.6 14.6c0-3.1 2.4-5.3 5.4-5.3s5.4 2.2 5.4 5.3" />
    </svg>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" aria-hidden="true">
      <path className="mk-dome" d="M 5 20 A 10 10 0 0 1 25 20" />
      <path className="mk-base" d="M 2 24.5 L 28 24.5" />
      <circle className="mk-dot" cx="15" cy="16" r="2.4" />
    </svg>
  );
}
