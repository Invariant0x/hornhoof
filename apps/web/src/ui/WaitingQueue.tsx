import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { EmptyBox } from './Cards';
import { TrackerIcon } from './icons';

export type WaitQueueEntry = {
  id: string;
  title: string;
  text: string;
  meta: ReactNode;
  icon: 'waits' | 'failure' | 'branch' | 'list';
  show: (done: () => void, defer: () => void) => ReactNode;
};

function orderedCards(items: WaitQueueEntry[], deferred: string[], finished: ReadonlySet<string>) {
  const remaining = items.filter(item => !finished.has(item.id));
  const byId = new Map(remaining.map(item => [item.id, item]));
  const later = new Set(deferred);
  return {
    later, byId,
    ordered: [...remaining.filter(item => !later.has(item.id)), ...deferred.flatMap(key => byId.get(key) ?? [])],
  };
}

function QueueStrips({ others, later, id, open }: { others: WaitQueueEntry[]; later: ReadonlySet<string>; id: string; open: (id: string) => void }) {
  const t = useT();
  if (!others.length) return null;
  return (
    <div className="wait-strips">
      <p className="wait-meta"><bdi>{t.tasks.queue.more(others.length)}</bdi></p>
      <ul>
        {others.map(item => (
          <li key={item.id}>
            <button type="button" className="wait-strip" aria-expanded={false} aria-controls={id} onClick={() => open(item.id)}>
              <TrackerIcon name={item.icon} />
              <span className="wait-strip-lines">
                <span className="wait-strip-text"><bdi>{item.text}</bdi>{later.has(item.id) && <span className="status wait-neutral">{t.tasks.queue.deferred}</span>}</span>
                <span className="wait-meta">{item.meta}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Deferred cards stay at the end in the order they were deferred. A successful answer hides its card while the server's
   next list is on the way, so work our caller still holds never flashes back into view. */
export function WaitingQueue({ items }: { items: WaitQueueEntry[] }) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef<HTMLElement>(null);
  const focus = useRef(false);
  const [picked, setPicked] = useState('');
  const [deferred, setDeferred] = useState<string[]>([]);
  const [finished, setFinished] = useState<Set<string>>(() => new Set());
  const { later, byId, ordered } = orderedCards(items, deferred, finished);
  const active = byId.get(picked) ?? ordered[0];
  const others = ordered.filter(item => item !== active);

  useLayoutEffect(() => {
    if (focus.current) heading.current?.focus({ preventScroll: true });
    focus.current = false;
  }, [active?.id]);

  if (!active) return <EmptyBox title={t.tasks.queue.empty} />;
  const open = (key: string) => {
    focus.current = true;
    setPicked(key);
  };
  const defer = () => {
    focus.current = others.length > 0;
    setDeferred(keys => [...keys.filter(key => key !== active.id), active.id]);
    setPicked('');
  };
  const done = () => {
    focus.current = Boolean(current.current?.contains(document.activeElement));
    setFinished(keys => new Set([...keys, active.id]));
    setPicked(key => key === active.id ? '' : key);
  };
  return (
    <div className="wait-queue">
      <section className="wait-current" id={id} ref={current}>
        <h3 className="sr" ref={heading} tabIndex={-1}><bdi>{active.title}</bdi></h3>
        <div className="wait-current-content" key={active.id}>{active.show(done, defer)}</div>
      </section>
      <QueueStrips others={others} later={later} id={id} open={open} />
    </div>
  );
}
