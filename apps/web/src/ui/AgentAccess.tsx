import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT } from '../i18n';
import { useStream } from '../live';
import { RouteUnavailable } from '../screens/RouteUnavailable';
import type { Org } from '../types';

type Status = 'checking' | 'allowed' | 'denied' | 'failure';
const RECHECK_MS = 5_000;

function listed(org: Org, agentId: string): boolean {
  if (org.orchestrator && (agentId === 'orchestrator' || agentId === org.orchestrator.id)) return true;
  return org.departments.some(department => department.employees.some(employee => employee.id === agentId));
}

function statusOf(failure: unknown): Status {
  if (failure instanceof ApiFailure && failure.status === 403) return 'denied';
  if (failure instanceof ApiFailure && failure.status === 404) return 'allowed';
  return 'failure';
}

function contentOf(status: Status, t: ReturnType<typeof useT>, failure: unknown, children: ReactNode): ReactNode {
  if (status === 'failure') return <p className="alert" role="alert">{errorText(t, failure)}</p>;
  return status === 'allowed' ? children : null;
}

export function AgentAccess({ agentId, org, onClose, children }: { agentId: string; org: Org; onClose(): void; children: ReactNode }) {
  const t = useT();
  const path = `/api/agents/${agentId}`;
  const sequence = useRef(0);
  const [status, setStatus] = useState<Status>('checking');
  const [failure, setFailure] = useState<unknown>(null);
  const check = useCallback(async () => {
    const own = ++sequence.current;
    try {
      await api.get(path);
      if (sequence.current === own) {
        setStatus('allowed');
        setFailure(null);
      }
    } catch (err) {
      if (sequence.current !== own) return;
      const next = statusOf(err);
      setStatus(next);
      if (next === 'failure') setFailure(err);
    }
  }, [path]);

  useEffect(() => {
    setStatus('checking');
    void check();
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [check]);

  useStream(message => {
    if (['org', 'task', 'working', 'reconnected'].includes(message.type)) void check();
  });

  if (status === 'denied' || !listed(org, agentId)) return <RouteUnavailable dialog onHome={onClose} />;
  return contentOf(status, t, failure, children);
}
