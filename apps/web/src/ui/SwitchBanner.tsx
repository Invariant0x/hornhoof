import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import type { MachineView, Switched, SwitchWord } from '../types';
import { RecoveryQuestion } from './RecoveryQuestion';
import { clock } from './subscription';

const EVERY_MS = 5_000;
const MOVING_MS = 1_000;
const SWITCHED_MS = 60_000;
const CLOSED = 'hh-switched-closed';

function closedId(): string | null {
  try {
    return localStorage.getItem(CLOSED);
  } catch {
    return null;
  }
}

function close(id: string): void {
  try {
    localStorage.setItem(CLOSED, id);
  } catch {
    /* Private windows may refuse; the line then comes back on the next visit. */
  }
}

/* Under the top bar, above every screen: while the company's server moves to another machine, a line that says so
   and where to; while this machine's copy is cut off from the server, that; while a copy asks which one to go on
   from, the question; and for a day after a move, where Hornhoof runs now, until the reader closes it. The keeper of
   the machine the page came from answers where the company moves, so the line stands also while the app is down.
   While none of this is to say, what else there is to say stands there. */
export function SwitchBanner({ children }: { children?: ReactNode }) {
  const t = useT();
  const { language } = useLanguage();
  const [word, setWord] = useState<SwitchWord | null>(null);
  const [switched, setSwitched] = useState<Switched | null>(null);
  const [, rerender] = useState(0);
  const hosts = useRef(new Map<string, string>());

  /* The machines' names, as the page last read them; someone who sees no machines reads the lines without names. */
  const readHosts = useCallback(
    () => api.get<{ machines: MachineView[] }>('/api/machines').then(said => { hosts.current = new Map(said.machines.map(machine => [machine.id, machine.hostname])); }, () => undefined),
    [],
  );
  /* A look that fails changes nothing: the last line stays. */
  const look = useCallback(() => api.get<SwitchWord>('/api/network/switch').then(setWord, () => undefined), []);
  const readSwitched = useCallback(() => api.get<{ switched: Switched | null }>('/api/network/switched').then(said => setSwitched(said.switched), () => undefined), []);

  const moving = word?.moving === true;
  useEffect(() => {
    void look();
    const timer = setInterval(() => void look(), moving ? MOVING_MS : EVERY_MS);
    return () => clearInterval(timer);
  }, [look, moving]);
  /* The names are read once: a move needs them while the app may be away. */
  useEffect(() => void readHosts(), [readHosts]);
  /* Read each minute, and once a move ended. */
  useEffect(() => {
    if (moving) return;
    void readSwitched();
    const timer = setInterval(() => void readSwitched(), SWITCHED_MS);
    return () => clearInterval(timer);
  }, [readSwitched, moving]);

  const nameOf = (id: string | null | undefined): string | null => (id ? (hosts.current.get(id) ?? null) : null);
  const line = (text: string) => <div className="update-banner glass" role="status" aria-label={t.switch.label}><span dir="auto">{text}</span></div>;
  /* A question that stands is the CEO's to answer, whatever else moves. */
  if (word?.moving && !word.question) {
    const [from, to] = [nameOf(word.from), nameOf(word.to)];
    if (word.to !== null) return line(to ? t.switch.moving(to) : t.switch.movingSomewhere);
    return line(from ? t.switch.lost(from) : t.switch.lostLeader);
  }
  const said = switched && closedId() !== switched.id ? switched : null;
  const after = said && (
    <div className="update-banner glass" role="status" aria-label={t.switch.label}>
      <span dir="auto">
        {said.kind === 'takeover' && said.reason === 'disk_full' ? t.switched.diskFull(said.from, said.to)
          : said.kind === 'takeover' ? t.switched.takeover(said.to, said.from, clock(language, said.heard))
            : said.kind === 'ceo' ? t.switched.ceo(said.to, clock(language, said.reach))
              : t.switched.planned(said.to)}
      </span>
      <button className="btn small ghost" type="button" onClick={() => { close(said.id); rerender(n => n + 1); }}>{t.switched.close}</button>
    </div>
  );
  return (
    <RecoveryQuestion again={word?.question === true}>
      {word?.cut ? line(t.switch.cut(nameOf(word.self), nameOf(word.from))) : (after ?? children)}
    </RecoveryQuestion>
  );
}
