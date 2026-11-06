import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import type { DecidedBy } from '../types';
import { DecidedByNote } from './DecidedBy';
import { Field } from './Field';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CatalogSourceSummary = {
  kind: string;
  entryId: string;
  revision: number;
  summary: string;
};

export type BoundMessageApproval = {
  kind: 'message';
  requestId: string;
  status: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  channel: { id: string; name: string; adapter: string; purpose: string; audience: 'direct' | 'public' };
  account: { id: string; label: string; senderDomain: string; bindingGeneration: number };
  messageId: string;
  revision: number;
  locale: string;
  contentDigest: string;
  policyDigest: string;
  sourceRevisionsDigest: string;
  rendered: { subject: string; body: string };
  sources: CatalogSourceSummary[];
};

export type BoundApproachApproval = {
  kind: 'approach';
  requestId: string;
  status: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  channel: { id: string; name: string; adapter: string; purpose: string; audience: 'direct' | 'public' };
  segment: { id: string; revision: number; name: string };
  template: { id: string; revision: number; locale: string; subject: string; preview: string };
  policyDigest: string;
  sourceRevisionsDigest: string;
  sources: CatalogSourceSummary[];
};

export type BoundOutboundApproval = BoundMessageApproval | BoundApproachApproval;

type OutboundChannelItem = {
  id: string;
  departmentId: string;
  productId: string | null;
  name: string;
  adapter: string;
  purpose: string;
  audience: 'direct' | 'public';
  status: 'new' | 'active' | 'stopped';
  generation: number;
  stoppedReason: string | null;
  stoppedAt: string | null;
  accounts: {
    id: string;
    label: string;
    senderDomain: string;
    status: string;
    configGeneration: number;
    available: boolean;
  }[];
};

type OutboundMessageItem = {
  id: string;
  departmentId: string;
  productId: string | null;
  taskId: string;
  channelId: string;
  channelName: string;
  accountId: string;
  accountLabel: string;
  senderDomain: string;
  revision: number;
  contentDigest: string;
  status: keyof ReturnType<typeof useT>['outbound']['messageStatuses'];
  reasonCodes: string[];
  scheduledAt: string;
  updatedAt: string;
  unknownRecovery?: {
    attemptId: string;
    safeCode: string;
    endedAt: string;
    quotaHeld: true;
    nextActionCode: 'check_receiver_before_resend';
  } | null;
};

type OutboundEscalationItem = {
  ticketId: string;
  externalRef?: string | null;
  revision: number;
  departmentId: string;
  productId: string | null;
  status: string;
  classId: string | null;
  reasonCodes: string[];
  requestId: string | null;
  taskId: string | null;
  ownerPersonId: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  createdAt: string;
};

type OutboundOverview = {
  channels: OutboundChannelItem[];
  messages: OutboundMessageItem[];
  escalations: OutboundEscalationItem[];
  approvals: BoundOutboundApproval[];
};

const shortDigest = (digest: string): string => digest.slice(0, 12);

function SourcesList({ sources }: { sources: CatalogSourceSummary[] }) {
  const t = useT();
  if (sources.length === 0) return null;
  return (
    <div className="outbound-sources">
      <small>
        <b>{t.outbound.sources}</b>
      </small>
      <ul className="req-ways">
        {sources.map(src => (
          <li key={`${src.entryId}-${src.revision}`}>
            {`${src.kind} (${t.outbound.revision(src.revision)}): ${src.summary}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageSnapshotBody({ item }: { item: BoundMessageApproval }) {
  const t = useT();
  return (
    <div className="outbound-bound">
      <p className="muted">
        {`${t.outbound.exactContent} · ${item.channel.name} · ${item.account.label} (${item.account.senderDomain}, ${t.outbound.generation(item.account.bindingGeneration)}) · ${item.locale}`}
      </p>
      <h4>{item.rendered.subject || t.outbound.noSubject}</h4>
      <pre className="req-text">{item.rendered.body}</pre>
      <p className="muted">
        <code>{`${t.outbound.contentDigest}: ${shortDigest(item.contentDigest)}`}</code>
        {' · '}
        <code>{`${t.outbound.sourcesDigest}: ${shortDigest(item.sourceRevisionsDigest)}`}</code>
      </p>
      <SourcesList sources={item.sources} />
    </div>
  );
}

function ApproachSnapshotBody({ item }: { item: BoundApproachApproval }) {
  const t = useT();
  const tplSubject = item.template.subject || t.outbound.noSubject;
  return (
    <div className="outbound-bound">
      <p className="muted">{`${t.outbound.exactApproach} · ${item.channel.name}`}</p>
      <p>
        <b>{t.outbound.segment}:</b> {`${item.segment.name} (${t.outbound.revision(item.segment.revision)})`}
      </p>
      <p>{`${t.outbound.template}: ${tplSubject} (${item.template.locale}, ${t.outbound.revision(item.template.revision)})`}</p>
      <pre className="req-text">{item.template.preview}</pre>
      <SourcesList sources={item.sources} />
    </div>
  );
}

export function BoundSnapshotDetails({ snapshot }: { snapshot: BoundOutboundApproval }) {
  if (snapshot.kind === 'message') return <MessageSnapshotBody item={snapshot} />;
  return <ApproachSnapshotBody item={snapshot} />;
}

export function BoundApprovalSnapshot({ requestId }: { requestId: string }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<BoundOutboundApproval | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!UUID_RE.test(requestId)) return;
    let active = true;
    setFailed(false);
    api
      .get<BoundOutboundApproval>(`/api/requests/${requestId}/outbound-approval`)
      .then(data => {
        if (active) setSnapshot(data);
      })
      .catch(err => {
        if (!active) return;
        if (err instanceof ApiFailure && err.status === 404) setSnapshot(null);
        else setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [requestId]);

  if (failed) return <p className="alert" role="alert">{t.outbound.snapshotError}</p>;
  if (!snapshot) return null;
  return <BoundSnapshotDetails snapshot={snapshot} />;
}

function OutboundApprovalCard({ item, onChanged }: { item: BoundOutboundApproval; onChanged: () => void }) {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      const payload = note.trim() ? { approve, answer: note.trim() } : { approve };
      await api.post(`/api/requests/${item.requestId}`, payload);
      onChanged();
    } catch (err) {
      setFailure(err);
      setBusy(false);
    }
  }

  return (
    <article className="req req-approval" aria-busy={busy}>
      <BoundSnapshotDetails snapshot={item} />
      {item.canAnswer ? (
        <div className="req-form">
          <Field label={t.tasks.note}>
            {p => <textarea {...p} rows={2} value={note} onChange={e => setNote(e.target.value)} />}
          </Field>
          <div className="req-actions">
            <button className="btn small" type="button" disabled={busy} onClick={() => void decide(true)}>
              {t.tasks.approve}
            </button>
            <button className="btn small ghost" type="button" disabled={busy} onClick={() => void decide(false)}>
              {t.tasks.decline}
            </button>
          </div>
        </div>
      ) : (
        <div className="req-form">
          <DecidedByNote by={item.decidedBy} />
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </article>
  );
}

function OutboundMessageRow({ item, onOpenTask }: { item: OutboundMessageItem; onOpenTask: (id: string) => void }) {
  const t = useT();
  const statusLabel = t.outbound.messageStatuses[item.status] ?? item.status;
  return (
    <div className="card">
      <header>
        <b>{`${item.channelName} · ${item.accountLabel}`}</b>{' '}
        <small className="muted">{`${statusLabel} · ${t.outbound.revision(item.revision)}`}</small>
      </header>
      <p className="muted">
        <code>{`${t.outbound.contentDigest}: ${shortDigest(item.contentDigest)}`}</code>
      </p>
      {item.unknownRecovery && (
        <p className="alert" role="status">
          {`${t.outbound.unknownHeading} (${item.unknownRecovery.safeCode}): ${t.outbound.unknownAction}`}
        </p>
      )}
      <div className="req-actions">
        <button className="btn small ghost" type="button" onClick={() => onOpenTask(item.taskId)}>
          {t.outbound.openTask}
        </button>
      </div>
    </div>
  );
}

function EscalationRow({ item, onOpenTask }: { item: OutboundEscalationItem; onOpenTask: (id: string) => void }) {
  const t = useT();
  const label = item.externalRef ?? item.ticketId;
  return (
    <div className="card">
      <header>
        <b>{t.outbound.ticket(label, item.revision)}</b>{' '}
        {item.classId && <small className="muted">{item.classId}</small>}
      </header>
      {!item.canAnswer && <DecidedByNote by={item.decidedBy} />}
      {item.taskId && (
        <div className="req-actions">
          <button className="btn small ghost" type="button" onClick={() => onOpenTask(item.taskId!)}>
            {t.outbound.openTask}
          </button>
        </div>
      )}
    </div>
  );
}

function ChannelRow({ channel }: { channel: OutboundChannelItem }) {
  const t = useT();
  return (
    <div className="card">
      <header>
        <b>{channel.name}</b>{' '}
        <small className="muted">
          {`${channel.adapter} · ${t.outbound.channelStatuses[channel.status]} · ${t.outbound.generation(channel.generation)}`}
        </small>
      </header>
      <ul className="req-ways">
        {channel.accounts.map(acc => (
          <li key={acc.id}>
            {`${acc.label} (${acc.senderDomain}) · ${acc.available ? t.outbound.accountReady : t.outbound.accountHeld}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function isEmptyOverview(data: OutboundOverview): boolean {
  const noActivity = data.approvals.length === 0 && data.messages.length === 0;
  return noActivity && data.escalations.length === 0 && data.channels.length === 0;
}

function OutboundSections({
  data,
  onChanged,
  onOpenTask,
}: {
  data: OutboundOverview;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="stack">
      <section>
        <h3>{t.outbound.approvalsHeading}</h3>
        {data.approvals.length === 0 ? (
          <p className="muted">{t.outbound.approvalsEmpty}</p>
        ) : (
          <div className="reqs">
            {data.approvals.map(item => (
              <OutboundApprovalCard key={item.requestId} item={item} onChanged={onChanged} />
            ))}
          </div>
        )}
      </section>
      {data.messages.length > 0 && (
        <section>
          <h3>{t.outbound.messagesHeading}</h3>
          <div className="stack">
            {data.messages.map(msg => (
              <OutboundMessageRow key={msg.id} item={msg} onOpenTask={onOpenTask} />
            ))}
          </div>
        </section>
      )}
      {data.escalations.length > 0 && (
        <section>
          <h3>{t.outbound.escalationsHeading}</h3>
          <div className="stack">
            {data.escalations.map(esc => (
              <EscalationRow key={`${esc.ticketId}-${esc.revision}`} item={esc} onOpenTask={onOpenTask} />
            ))}
          </div>
        </section>
      )}
      {data.channels.length > 0 && (
        <section>
          <h3>{t.outbound.channelsHeading}</h3>
          <div className="stack">
            {data.channels.map(ch => (
              <ChannelRow key={ch.id} channel={ch} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function Outbound({ onOpenTask, onHome: _onHome }: { onOpenTask: (id: string) => void; onHome?: () => void }) {
  const t = useT();
  const [data, setData] = useState<OutboundOverview | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const load = useCallback(() => {
    setFailure(null);
    api
      .get<OutboundOverview>('/api/outbound')
      .then(setData)
      .catch(setFailure);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="page-body outbound-screen">
      <header className="page-head">
        <h2>{t.outbound.heading}</h2>
        <p className="muted">{t.outbound.intro}</p>
      </header>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {!data && failure === null && <p className="muted" role="status">{t.tasks.sending}</p>}
      {data && isEmptyOverview(data) && <p className="muted">{t.outbound.empty}</p>}
      {data && !isEmptyOverview(data) && <OutboundSections data={data} onChanged={load} onOpenTask={onOpenTask} />}
    </section>
  );
}
