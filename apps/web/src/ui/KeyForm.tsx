import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { SubView } from '../types';

/* Plans that sign in with a key pasted once, and where their owner gets one. */
export const KEY_PLANS = {
  kimi: { kind: 'kimi_key', page: 'https://www.kimi.com/code/console' },
  glm: { kind: 'glm_key', page: 'https://z.ai/manage-apikey/apikey-list' },
} as const;
export type KeyPlan = keyof typeof KEY_PLANS;
export const isKeyPlan = (provider: string): provider is KeyPlan => provider in KEY_PLANS;

type Recipients = { version: number; recipients: { nodeId: string; publicKey: string }[] };

/* The owner pastes a plan's key once. The browser seals it to each machine of the plan, so Hornhoof stores and passes on
   only what those machines open, and the key never reaches it. */
export function KeyForm({ sub, onDone, onCancel }: { sub: SubView & { provider: KeyPlan }; onDone(): void; onCancel(): void }) {
  const t = useT();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const provider = PROVIDER_NAMES[sub.provider];
  const plan = KEY_PLANS[sub.provider];

  async function save(e: FormEvent) {
    e.preventDefault();
    const secret = key.trim();
    if (!secret || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const { version, recipients } = await api.get<Recipients>(`/api/subscriptions/${sub.id}/recipients`);
      if (!recipients.length) return setProblem(t.subs.noKeyMachine);
      /* The sealing code loads only when someone saves a key. */
      const { sealFor } = await import('../seal');
      const envelopes = await Promise.all(recipients.slice(0, 20).map(async r => ({ nodeId: r.nodeId, sealed: await sealFor([r.publicKey], secret) })));
      await api.post(`/api/subscriptions/${sub.id}/credential`, { kind: plan.kind, version: version + 1, envelopes });
      setKey('');
      onDone();
    } catch (err) {
      setProblem(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="key-form" onSubmit={e => void save(e)}>
      <label>
        <span>{t.subs.keyField(provider)}</span>
        <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} />
      </label>
      <p className="muted">
        <a href={plan.page} target="_blank" rel="noreferrer">{t.subs.keyPage(provider)}</a>. {t.subs.keyNote}
      </p>
      {problem && <p className="alert" role="alert">{problem}</p>}
      <div className="actions">
        <button className="btn small" type="submit" disabled={busy || !key.trim()}>{t.subs.saveKey}</button>
        <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}
