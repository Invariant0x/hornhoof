import { useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';
import { currentTheme, exportTemplate, loadTemplate, resetTemplate, setTheme, subscribeTheme, themeState, type Theme } from '../theme';
import { TEMPLATE_LIMIT, THEMES, type TemplateError } from '../theme-template';
import { useDialogClose } from './use-dialog-close';

type Problem = TemplateError | { code: 'read_failed'; key?: string };

function useTheme() {
  const state = useSyncExternalStore(subscribeTheme, themeState);
  return { custom: state.custom, theme: currentTheme() };
}

const problemText = (t: Messages, problem: Problem) => t.themeTemplate.errors[problem.code](problem.key ?? '');

/* The four built-in themes, and the custom template as a fifth while one is kept. The account menu and the settings show
   the same choice. */
export function ThemeChoice() {
  const t = useT();
  const { custom, theme } = useTheme();
  const choices: Theme[] = custom ? [...THEMES, 'custom'] : [...THEMES];
  return (
    <div className="menu-row" role="group" aria-label={t.shell.theme}>
      <span>{t.shell.theme}</span>
      <div className="seg themes">
        {choices.map(id => (
          <button key={id} type="button" aria-pressed={theme === id} onClick={() => setTheme(id)}>
            {t.shell[id]}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Loads a template from a file, gives out the theme that is on as a sample, and forgets the template. Anyone can use it:
   the template is kept in this browser only. */
export function ThemeTemplate() {
  const t = useT();
  const { custom, theme } = useTheme();
  const [problem, setProblem] = useState<Problem | null>(null);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    /* The same file can be picked again after it is fixed. */
    input.value = '';
    if (!file) return;
    if (file.size > TEMPLATE_LIMIT) return setProblem({ code: 'too_large' });
    try {
      setProblem(loadTemplate(await file.text()));
    } catch {
      setProblem({ code: 'read_failed' });
    }
  }

  /* The same words whichever theme is on, so switching moves nothing; the choice shows whether the template is on. */
  const status = custom ? t.themeTemplate.loaded(custom.name) : t.themeTemplate.none;
  const sample = `data:application/json;charset=utf-8,${encodeURIComponent(exportTemplate())}`;
  return (
    <div className="theme-template">
      <p>{t.themeTemplate.about}</p>
      <p>{status}</p>
      <div className="settings-actions">
        <label className="btn small ghost theme-load">
          <input className="sr" type="file" accept=".json,application/json" onChange={event => void pick(event)} />
          {t.themeTemplate.load}
        </label>
        <a className="btn small ghost" href={sample} download={`hornhoof-theme-${theme}.json`}>
          {t.themeTemplate.download}
        </a>
        {custom && (
          <button
            className="btn small ghost"
            type="button"
            onClick={() => {
              resetTemplate();
              setProblem(null);
            }}
          >
            {t.themeTemplate.reset}
          </button>
        )}
      </div>
      {problem && <p className="alert" role="alert">{problemText(t, problem)}</p>}
    </div>
  );
}

/* The small window the account menu opens, for everyone, with the same block as the settings. */
export function ThemeTemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const box = useDialogClose(onClose);
  return (
    <div className="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="dialog theme-dialog" role="dialog" aria-modal="true" aria-labelledby="theme-template-title" tabIndex={-1} ref={box}>
        <header>
          <h2 id="theme-template-title">{t.themeTemplate.title}</h2>
          <button className="btn small ghost" type="button" onClick={onClose}>{t.common.done}</button>
        </header>
        <ThemeTemplate />
      </div>
    </div>
  );
}
