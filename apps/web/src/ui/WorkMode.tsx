import type { DepartmentWorkMode } from '@hornhoof/protocol';
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { WorkModeView } from '../types';

const MODES: DepartmentWorkMode[] = ['turns', 'continuous'];

type Props = {
  departmentId: string;
  /* The mode as the company reads it now, so a change made elsewhere shows here too. */
  workMode?: DepartmentWorkMode;
};

/* Whether a department works in the company's turns, its tasks counted on the map, or all the time. Whoever the server lets
   change it picks one, saved as it is picked; anyone else reads it in words. */
export function WorkMode({ departmentId, workMode }: Props) {
  const tt = useT();
  const t = tt.dept.workMode;
  const uid = useId();
  const path = `/api/departments/${departmentId}/work-mode`;
  const [view, setView] = useState<WorkModeView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  /* The way just picked shows picked while it is saved. */
  const [picked, setPicked] = useState<DepartmentWorkMode | null>(null);
  const words: Record<DepartmentWorkMode, [string, string]> = { turns: [t.turns, t.turnsHint], continuous: [t.continuous, t.continuousHint] };

  const load = useCallback(async () => {
    try {
      setView(await api.get<WorkModeView>(path));
      setFailure(null);
    } catch (err) {
      setFailure(err);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, workMode]);

  /* A refused change goes back to the stored mode, with the reason under it. */
  async function pick(mode: DepartmentWorkMode) {
    setPicked(mode);
    setFailure(null);
    try {
      setView(await api.put<WorkModeView>(path, { workMode: mode }));
    } catch (err) {
      setFailure(err);
    } finally {
      setPicked(null);
    }
  }

  const problem = failure !== null && <p className="alert" role="alert">{errorText(tt, failure)}</p>;
  if (!view) return problem || <p className="muted">{tt.common.loading}</p>;
  if (!view.canChangeWorkMode) return <p>{view.workMode === 'turns' ? t.isTurns : t.isContinuous}</p>;
  const shown = picked ?? view.workMode;
  return (
    <>
      <fieldset className="choice">
        <legend className="sr">{t.title}</legend>
        {MODES.map(mode => (
          <label key={mode} className={shown === mode ? 'on' : ''}>
            <input type="radio" name={uid} value={mode} checked={shown === mode} disabled={picked !== null} onChange={() => void pick(mode)} aria-labelledby={`${uid}-${mode}`} aria-describedby={`${uid}-${mode}-hint`} />
            <b id={`${uid}-${mode}`}>{words[mode][0]}</b>
            <span id={`${uid}-${mode}-hint`}>{words[mode][1]}</span>
          </label>
        ))}
      </fieldset>
      {problem}
    </>
  );
}
