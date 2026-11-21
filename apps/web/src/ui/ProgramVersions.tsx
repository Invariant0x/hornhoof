import { useState, type ReactNode } from 'react';
import type { ProgramInfo } from '@hornhoof/protocol';
import { api } from '../api';
import { Phrase, useT } from '../i18n';
import { Facts, Part } from './Cards';
import { useConfirmAction } from './ConfirmAction';

const NAMES: Record<ProgramInfo['id'], string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code' };
type Programs = ProgramInfo[] | null | undefined;
type Props = { id: string; hostname?: string; online: boolean; programs: Programs; canUpdate: boolean; onUpdated(): Promise<void> };

function ProgramVersion({ program }: { program: ProgramInfo }) {
  const t = useT();
  return <div>{program.version ?? t.machines.programVersionUnknown}
    {program.updating && <small>{t.machines.programUpdating}</small>}
    {program.failed && !program.repair && <small><span className="update-error">{t.machines.programUpdateFailed}</span></small>}
    {program.repair === 'reinstalling' && <small>{t.machines.programReinstalling}</small>}
    {program.repair === 'broken' && <small><span className="update-error">{t.machines.programBroken(program.reason ?? null)}</span></small>}
  </div>;
}

function ProgramRows({ programs }: { programs: ProgramInfo[] }) {
  const items = Object.entries(NAMES).flatMap<[string, ReactNode]>(([id, name]) => {
    const versions = programs.filter(program => program.id === id);
    return versions.length ? [[name, <>{versions.map(program => <ProgramVersion key={JSON.stringify([program.id, program.version])} program={program} />)}</>]] : [];
  });
  return <Facts items={items} />;
}

function ProgramBody({ online, programs }: { online: boolean; programs: Programs }) {
  const t = useT();
  if (!online) return <p className="part-note">{t.machines.programsOffline}</p>;
  if (!programs) return <p className="part-note">{t.machines.programsUnknown}</p>;
  if (!programs.length) return <><p className="part-note">{t.machines.programsEmpty}</p><p className="part-note">{t.machines.programsEmptyHint}</p></>;
  return <ProgramRows programs={programs} />;
}

function useProgramUpdate(id: string, onUpdated: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const update = async () => {
    setPending(true);
    try {
      await api.post(`/api/machines/${encodeURIComponent(id)}/programs/update`);
      await onUpdated();
    } finally {
      setPending(false);
    }
  };
  return { pending, update };
}

const hasPrograms = (online: boolean, programs: Programs) => online && Boolean(programs?.length);
const updating = (programs: Programs) => programs?.some(program => program.updating) ?? false;

function ProgramControls({ id, hostname, online, programs, canUpdate, onUpdated }: Props) {
  const t = useT();
  const { pending, update } = useProgramUpdate(id, onUpdated);
  const confirmation = useConfirmAction();
  const busy = pending || (online && updating(programs));
  const askUpdate = () => {
    const words = t.machines.confirm.updatePrograms;
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{hostname ?? id}</bdi>]} />,
      onYes: update,
    });
  };
  return <>
    {canUpdate && <div className="entry-actions"><button type="button" className="act" disabled={!hasPrograms(online, programs) || busy} onClick={askUpdate}>{t.machines.updatePrograms}</button></div>}
    {busy && <p className="part-note" role="status">{t.machines.programsUpdating}</p>}
    {confirmation.question}
  </>;
}

export function ProgramVersions(props: Props) {
  const t = useT();
  return <Part title={t.machines.programs}>
    <ProgramBody online={props.online} programs={props.programs} />
    <ProgramControls {...props} />
  </Part>;
}
