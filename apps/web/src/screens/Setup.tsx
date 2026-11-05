import { useId, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { PLAN_PROVIDERS, PROVIDER_NAMES, type PlanProvider } from '../providers';
import { Card } from '../ui/Card';
import { CommandBox } from '../ui/CommandBox';
import { CompanyTemplates, type Pick } from '../ui/CompanyTemplates';
import { Field } from '../ui/Field';
import { blocks, LinkName, type NameCheck, type NameState } from '../ui/LinkName';
import { LinkReady, type MadeLink } from '../ui/LinkReady';

type Mode = 'api_key' | 'personal' | 'later';
type KeyProvider = 'anthropic_api' | 'openai_api';

const MODES: Mode[] = ['api_key', 'personal', 'later'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* The setup link the server logs carries the code that lets this browser create the company. */
const linkCode = () => new URLSearchParams(window.location.search).get('code')?.trim() ?? '';

const LINK_REFUSED = new Set(['link_taken', 'link_reserved', 'link_invalid']);

/* linkDomain: what public links end in, as the server says. */
export function Setup({ onDone, linkDomain = 'hornhoof.org' }: { onDone: (done: { welcome: boolean }) => void; linkDomain?: string }) {
  const t = useT();
  const steps = t.setup.steps;
  const uid = useId();
  const [step, setStep] = useState(0);
  const [code, setCode] = useState(linkCode);
  const [askCode, setAskCode] = useState(() => !linkCode());
  const [companyName, setCompanyName] = useState('');
  /* The ready-made company the CEO starts from, or "empty" to let the orchestrator build it. */
  const [template, setTemplate] = useState<Pick>('empty');
  /* The public link: on unless the person turns it off, starting on a long random name. */
  const [linkOn, setLinkOn] = useState(true);
  const [linkName, setLinkName] = useState('');
  const [linkState, setLinkState] = useState<NameState>('empty');
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
  const [skipLink, setSkipLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  /* The link setup made, shown with its certificate before the person goes on. */
  const [made, setMade] = useState<MadeLink | null>(null);

  function next(e: FormEvent) {
    e.preventDefault();
    if (step === 0) setProblems({});
    if (step === 1) {
      const found: Record<string, string> = {};
      if (!EMAIL.test(email.trim())) found.email = t.setup.emailProblem;
      if (password.length < 10) found.password = t.common.useAtLeast10;
      setProblems(found);
      if (Object.keys(found).length) return;
    }
    setStep(step + 1);
  }

  const checkName = (name: string) => api.get<NameCheck>(`/api/setup/names/${encodeURIComponent(name)}?code=${encodeURIComponent(code.trim())}`);

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (mode === 'api_key' && apiKey.trim().length < 8) {
      setProblems({ apiKey: t.setup.pasteWholeKey });
      return;
    }
    const orchestrator =
      mode === 'api_key' ? { mode, provider: keyProvider, apiKey: apiKey.trim() } : mode === 'personal' ? { mode, provider: plan } : { mode };
    setBusy(true);
    setFailure('');
    setSkipLink(false);
    try {
      const res = await api.post<{ command?: string; link?: MadeLink }>('/api/setup', {
        code: code.trim(),
        companyName: companyName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        title: title.trim(),
        orchestrator,
        ...(linkOn ? { link: { name: linkName } } : {}),
        ...(template === 'empty' ? {} : { template }),
      });
      setCommand(res.command ?? null);
      if (res.link) setMade(res.link);
      else if (!res.command) onDone({ welcome: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.reason === 'setup_code') {
        setAskCode(true);
        setProblems({ code: errorText(t, err) });
        setStep(0);
      } else if (err instanceof ApiFailure && err.reason && LINK_REFUSED.has(err.reason)) {
        setProblems({ link: errorText(t, err) });
        setStep(0);
      } else {
        setFailure(errorText(t, err));
        setSkipLink(err instanceof ApiFailure && err.reason === 'relay_unreachable');
      }
    } finally {
      setBusy(false);
    }
  }

  function goOn() {
    setMade(null);
    if (!command) onDone({ welcome: true });
  }

  if (made) {
    return (
      <Card>
        <h1>{t.settings.link}</h1>
        <LinkReady link={made} onNext={goOn} />
      </Card>
    );
  }

  if (command) {
    return (
      <Card>
        <h1>{t.setup.connectMachine}</h1>
        <p className="muted">{t.setup.runThis(PROVIDER_NAMES[plan])}</p>
        <CommandBox command={command} />
        <p className="muted">{t.setup.joinOnce}</p>
        <div className="actions">
          <button className="btn" type="button" onClick={() => onDone({ welcome: true })}>{t.setup.goToMap}</button>
        </div>
      </Card>
    );
  }

  return (
    <Card wide={step === 0}>
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
          <div className="setup-lead">
            <Field label={t.setup.companyName}>
              {p => <input {...p} value={companyName} onChange={e => setCompanyName(e.target.value)} maxLength={80} autoFocus autoComplete="organization" />}
            </Field>
          </div>
          <CompanyTemplates value={template} onPick={setTemplate} />
          <div className="setup-lead">
            <label className="check">
              <input type="checkbox" checked={linkOn} onChange={e => setLinkOn(e.target.checked)} aria-labelledby={`${uid}-link`} aria-describedby={`${uid}-link-hint`} />
              <span>
                <b id={`${uid}-link`}>{t.link.open}</b>
                <small id={`${uid}-link-hint`}>{t.link.openHint}</small>
              </span>
            </label>
            {linkOn && (
              <LinkName
                name={linkName}
                onName={name => {
                  setLinkName(name);
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit the cleared link problem
                  setProblems(({ link: _, ...rest }) => rest);
                }}
                domain={linkDomain}
                check={checkName}
                onState={setLinkState}
                problem={problems.link}
                startRandom
              />
            )}
            {askCode && (
              <Field label={t.setup.code} problem={problems.code} hint={t.setup.codeHint}>
                {p => <input {...p} value={code} onChange={e => setCode(e.target.value)} maxLength={200} autoComplete="off" spellCheck={false} />}
              </Field>
            )}
          </div>
          <div className="actions">
            <button className="btn" type="submit" disabled={!companyName.trim() || (askCode && !code.trim()) || (linkOn && (blocks(linkState) || !!problems.link))}>{t.common.next}</button>
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
        <form onSubmit={e => void finish(e)} noValidate>
          <p className="muted">{t.setup.orchestratorIntro}</p>
          <fieldset className="choice">
            <legend className="sr">{t.setup.howOrchestratorRuns}</legend>
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
          {failure && skipLink && <p className="muted">{t.link.skipHint}</p>}
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => setStep(1)}>{t.common.back}</button>
            <button className="btn" type="submit" disabled={busy}>{t.setup.finish}</button>
          </div>
        </form>
      )}
    </Card>
  );
}
