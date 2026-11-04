import { render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentMessage, useFolding, type AgentMessageView } from '../src/ui/AgentMessage';

const MESSAGE: AgentMessageView = {
  direction: 'in',
  from: { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null },
  to: { kind: 'agent', id: 'a1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' },
};

function MessageLog({ seqs, on }: { seqs: number[]; on: boolean }) {
  const box = useRef<HTMLElement>(null);
  const folding = useFolding(seqs, box, on);
  return <section ref={box}>{seqs.map(seq => <AgentMessage key={seq} message={MESSAGE} text={`Message ${seq}`} open={folding.opened.has(seq)} onToggle={() => folding.toggle(seq)} />)}</section>;
}

/* A key arriving after the log commits, before passive effects: no mocked hooks or timer controls. */
function KeyAtCommit({ press }: { press: boolean }) {
  useLayoutEffect(() => {
    if (press) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }));
  }, [press]);
  return null;
}

const log = (seqs: number[], on: boolean, press: boolean) => <LanguageProvider><MessageLog seqs={seqs} on={on} /><KeyAtCommit press={press} /></LanguageProvider>;

describe('message folding at commit', () => {
  it('takes Ctrl+O as soon as the messages first appear', () => {
    render(log([1], true, true));
    expect(screen.getByText('Message 1')).toBeInTheDocument();
  });

  it.each([
    { before: [], after: [1] },
    { before: [1], after: [1, 2] },
  ])('takes Ctrl+O for the messages just added to $before', ({ before, after }) => {
    const view = render(log(before, true, false));
    view.rerender(log(after, true, true));
    for (const seq of after) expect(screen.getByText(`Message ${seq}`)).toBeInTheDocument();
  });

  it('leaves Ctrl+O to the program as soon as the log is no longer active', () => {
    const view = render(log([1], true, false));
    view.rerender(log([1], false, true));
    expect(screen.queryByText('Message 1')).not.toBeInTheDocument();
  });
});
