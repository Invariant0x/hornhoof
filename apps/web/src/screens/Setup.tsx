import { useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { PLAN_PROVIDERS, PROVIDER_NAMES, type PlanProvider } from '../providers';
import { Card } from '../ui/Card';
import { CommandBox } from '../ui/CommandBox';
import { Field } from '../ui/Field';

type Mode = 'api_key' | 'personal' | 'later';
type KeyProvider = 'anthropic_api' | 'openai_api';

const MODES: Mode[] = ['api_key', 'personal', 'later'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Setup({ onDone }: { onDone: () => void }) {
  const t = useT();
  const steps = t.setup.steps;
  const uid = useId();
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('CEO');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('api_key');
  const [keyProvider, setKeyProvider] = useState<KeyProvider>('anthropic_api');
  const [apiKey, setApiKey] = useState('');
  const [plan, setPlan] = useState<PlanProvider>('claude');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);

  function next(e: FormEvent) {
    e.preventDefault();
    if (step === 1) {
      const found: Record<string, string> = {};
      if (!EMAIL.test(email.trim())) found.email = t.setup.emailProblem;
      if (password.length < 10) found.password = t.common.useAtLeast10;
      setProblems(found);
      if (Object.keys(found).length) return;
    }
    setStep(step + 1);
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (mode === 'api_key' && apiKey.trim().length < 8) {
      setProblems({ apiKey: t.setup.pasteWholeKey });
      return;
    }
    const chief =
      mode === 'api_key' ? { mode, provider: keyProvider, apiKey: apiKey.trim() } : mode === 'personal' ? { mode, provider: plan } : { mode };
    setBusy(true);
    setFailure('');
    try {
      const res = await api.post<{ command?: string }>('/api/setup', {
        companyName: companyName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        title: title.trim(),
        chief,
      });
      if (res.command) setCommand(res.command);
      else onDone();
    } catch (err) {
      setFailure(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (command) {
    return (
      <Card>
        <h1>{t.setup.connectMachine}</h1>
        <p className="muted">{t.setup.runThis(PROVIDER_NAMES[plan])}</p>
        <CommandBox command={command} />
        <p className="muted">{t.setup.joinOnce}</p>
        <div className="actions">
          <button className="btn" type="button" onClick={onDone}>{t.setup.goToMap}</button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="wizard-head">
        <p className="muted">{t.setup.heading}</p>
        <ol className="steps" aria-label={t.setup.stepOf(step + 1, steps.length)}>
          {steps.map((title, i) => (
            <li key={title} className={i <= step ? 'on' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="sr">{title}</span>
            </li>
          ))}
        </ol>
        <h1>{steps[step]}</h1>
      </div>

      {step === 0 && (
        <form onSubmit={next}>
          <Field label={t.setup.companyName}>
            {p => <input {...p} value={companyName} onChange={e => setCompanyName(e.target.value)} maxLength={80} autoFocus autoComplete="organization" />}
          </Field>
          <div className="actions">
            <button className="btn" type="submit" disabled={!companyName.trim()}>{t.common.next}</button>
          </div>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={next} noValidate>
          <p className="muted">{t.setup.becomeCeo(companyName.trim())}</p>
          <Field label={t.setup.yourName}>
            {p => <input {...p} value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus autoComplete="name" />}
          </Field>
          <Field label={t.setup.yourTitle}>
            {p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} autoComplete="organization-title" />}
          </Field>
          <Field label={t.common.email} problem={problems.email}>
            {p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />}
          </Field>
          <Field label={t.common.password} problem={problems.password} hint={t.common.atLeast10}>
            {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />}
          </Field>
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => setStep(0)}>{t.common.back}</button>
            <button className="btn" type="submit" disabled={!name.trim() || !email.trim() || !password}>{t.common.next}</button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={finish} noValidate>
          <p className="muted">{t.setup.chiefIntro}</p>
          <fieldset className="choice">
            <legend className="sr">{t.setup.howChiefRuns}</legend>
            {MODES.map(id => (
              <label key={id} className={mode === id ? 'on' : ''}>
                <input
                  type="radio"
                  name="mode"
                  value={id}
                  checked={mode === id}
                  onChange={() => setMode(id)}
                  aria-labelledby={`${uid}-${id}`}
                  aria-describedby={`${uid}-${id}-hint`}
                />
                <b id={`${uid}-${id}`}>{t.setup.modes[id].label}</b>
                <span id={`${uid}-${id}-hint`}>{t.setup.modes[id].hint}</span>
              </label>
            ))}
          </fieldset>

          {mode === 'api_key' && (
            <>
              <Field label={t.setup.provider}>
                {p => (
                  <select {...p} value={keyProvider} onChange={e => setKeyProvider(e.target.value as KeyProvider)}>
                    <option value="anthropic_api">Anthropic</option>
                    <option value="openai_api">OpenAI</option>
                  </select>
                )}
              </Field>
              <Field label={t.setup.key} problem={problems.apiKey}>
                {p => <input {...p} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
            </>
          )}

          {mode === 'personal' && (
            <fieldset className="segments">
              <legend className="sr">{t.setup.subscription}</legend>
              {PLAN_PROVIDERS.map(id => (
                <label key={id} className={plan === id ? 'on' : ''}>
                  <input type="radio" name="plan" value={id} checked={plan === id} onChange={() => setPlan(id)} />
                  {PROVIDER_NAMES[id]}
                </label>
              ))}
            </fieldset>
          )}

          {failure && <p className="alert" role="alert">{failure}</p>}
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => setStep(1)}>{t.common.back}</button>
            <button className="btn" type="submit" disabled={busy}>{t.setup.finish}</button>
          </div>
        </form>
      )}
    </Card>
  );
}
