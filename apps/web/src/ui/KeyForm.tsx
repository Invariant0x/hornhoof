import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { SubView } from '../types';
import { BusyLabel } from './BusyLabel';
import { Field } from './Field';
import { SecretInput } from './SecretInput';

/* Plans that sign in with a key pasted once, and where their owner gets one. */
const KEY_PLANS = {
  kimi: { kind: 'kimi_key', page: 'https://www.kimi.com/code/console' },
  glm: { kind: 'glm_key', page: 'https://z.ai/manage-apikey/apikey-list' },
} as const;
type KeyPlan = keyof typeof KEY_PLANS;
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

  /* The note says how the key is kept, with where to get one after it. */
  const hint = <>{t.subs.keyNote} <a href={plan.page} target="_blank" rel="noreferrer">{t.subs.keyPage(provider)}</a>.</>;
  return (
    <form className="key-form form-grid" onSubmit={e => void save(e)}>
      <Field label={t.subs.keyField(provider)} hint={hint}>
        {p => <SecretInput {...p} className="mono" value={key} onChange={e => setKey(e.target.value)} />}
      </Field>
      {problem && <p className="alert" role="alert">{problem}</p>}
      <div className="form-foot">
        <button className="btn" type="submit" aria-busy={busy} disabled={busy || !key.trim()}>
          <BusyLabel busy={busy} idle={t.subs.connectKey} working={t.subs.connecting} />
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}
