import { useId, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { Field } from '../ui/Field';
import { nodeCommand } from '../ui/nodeCommand';

type Mode = 'api_key' | 'personal' | 'later';
type KeyProvider = 'anthropic_api' | 'openai_api';
type PlanProvider = 'claude' | 'codex' | 'kimi';

const STEPS = ['Name your company', 'Create your account', 'Connect the chief'];
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'api_key', label: 'API key', hint: 'Paste a company key. It is stored encrypted and never shown again.' },
  { id: 'personal', label: 'My subscription', hint: 'Your own Claude, Codex or Kimi plan. It runs on your machine through a small Docker node.' },
  { id: 'later', label: 'Later', hint: 'The chief waits until you connect a subscription.' },
];
const PLANS: { id: PlanProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'kimi', label: 'Kimi' },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Setup({ onDone }: { onDone: () => void }) {
  const uid = useId();
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('api_key');
  const [keyProvider, setKeyProvider] = useState<KeyProvider>('anthropic_api');
  const [apiKey, setApiKey] = useState('');
  const [plan, setPlan] = useState<PlanProvider>('claude');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [join, setJoin] = useState<{ code: string; server: string } | null>(null);

  function next(e: FormEvent) {
    e.preventDefault();
    if (step === 1) {
      const found: Record<string, string> = {};
      if (!EMAIL.test(email.trim())) found.email = 'Enter an email like name@company.com.';
      if (password.length < 10) found.password = 'Use at least 10 characters.';
      setProblems(found);
      if (Object.keys(found).length) return;
    }
    setStep(step + 1);
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (mode === 'api_key' && apiKey.trim().length < 8) {
      setProblems({ apiKey: 'Paste the whole key.' });
      return;
    }
    const chief =
      mode === 'api_key' ? { mode, provider: keyProvider, apiKey: apiKey.trim() } : mode === 'personal' ? { mode, provider: plan } : { mode };
    setBusy(true);
    setFailure('');
    try {
      const res = await api.post<{ joinCode?: string; serverUrl?: string }>('/api/setup', {
        companyName: companyName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        chief,
      });
      if (res.joinCode) setJoin({ code: res.joinCode, server: res.serverUrl ?? window.location.origin });
      else onDone();
    } catch (err) {
      setFailure(err instanceof ApiFailure ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (join) {
    const command = nodeCommand(join.code, join.server);
    return (
      <Card>
        <h1>Connect your machine</h1>
        <p className="muted">Run this on the computer where your {PLANS.find(p => p.id === plan)!.label} subscription is signed in. The chief starts working as soon as the node connects.</p>
        <div className="command">
          <code>{command}</code>
          <CopyButton text={command} />
        </div>
        <p className="muted">The join code works once. You can close this page, the node keeps running in the background.</p>
        <div className="actions">
          <button className="btn" type="button" onClick={onDone}>Go to the map</button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="wizard-head">
        <p className="muted">Set up your company</p>
        <ol className="steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((title, i) => (
            <li key={title} className={i <= step ? 'on' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="sr">{title}</span>
            </li>
          ))}
        </ol>
        <h1>{STEPS[step]}</h1>
      </div>

      {step === 0 && (
        <form onSubmit={next}>
          <Field label="Company name">
            {p => <input {...p} value={companyName} onChange={e => setCompanyName(e.target.value)} maxLength={80} autoFocus autoComplete="organization" />}
          </Field>
          <div className="actions">
            <button className="btn" type="submit" disabled={!companyName.trim()}>Next</button>
          </div>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={next} noValidate>
          <p className="muted">You become the CEO of {companyName.trim()} and can see and run every department.</p>
          <Field label="Your name">
            {p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus autoComplete="name" />}
          </Field>
          <Field label="Email" problem={problems.email}>
            {p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />}
          </Field>
          <Field label="Password" problem={problems.password} hint="At least 10 characters.">
            {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />}
          </Field>
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => setStep(0)}>Back</button>
            <button className="btn" type="submit" disabled={!name.trim() || !email.trim() || !password}>Next</button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={finish} noValidate>
          <p className="muted">The chief is the agent in the center of the map. It builds departments for you and runs on this subscription.</p>
          <fieldset className="choice">
            <legend className="sr">How the chief runs</legend>
            {MODES.map(m => (
              <label key={m.id} className={mode === m.id ? 'on' : ''}>
                <input
                  type="radio"
                  name="mode"
                  value={m.id}
                  checked={mode === m.id}
                  onChange={() => setMode(m.id)}
                  aria-labelledby={`${uid}-${m.id}`}
                  aria-describedby={`${uid}-${m.id}-hint`}
                />
                <b id={`${uid}-${m.id}`}>{m.label}</b>
                <span id={`${uid}-${m.id}-hint`}>{m.hint}</span>
              </label>
            ))}
          </fieldset>

          {mode === 'api_key' && (
            <>
              <Field label="Provider">
                {p => (
                  <select {...p} value={keyProvider} onChange={e => setKeyProvider(e.target.value as KeyProvider)}>
                    <option value="anthropic_api">Anthropic</option>
                    <option value="openai_api">OpenAI</option>
                  </select>
                )}
              </Field>
              <Field label="Key" problem={problems.apiKey}>
                {p => <input {...p} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
            </>
          )}

          {mode === 'personal' && (
            <fieldset className="segments">
              <legend className="sr">Subscription</legend>
              {PLANS.map(p => (
                <label key={p.id} className={plan === p.id ? 'on' : ''}>
                  <input type="radio" name="plan" value={p.id} checked={plan === p.id} onChange={() => setPlan(p.id)} />
                  {p.label}
                </label>
              ))}
            </fieldset>
          )}

          {failure && <p className="alert" role="alert">{failure}</p>}
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn" type="submit" disabled={busy}>Finish setup</button>
          </div>
        </form>
      )}
    </Card>
  );
}
