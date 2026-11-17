import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasTmux, host, job, sent, setUp, until } from './terminal-host-helpers.js';

const shown = (termId: string) => sent.flatMap(m => (m.type === 'term.data' && m.termId === termId ? [String(m.data)] : [])).join('');

describe.skipIf(!hasTmux)('the current screen after initial history and attach redraw', () => {
  beforeEach(() => setUp());
  afterEach(async () => host.stop());

  it('does not repeat the current output in the scrollback stream', async () => {
    await host.run(job('duplicate', 'hello'));
    await host.open({ type: 'term.open', termId: 'duplicate', agentKey: 'duplicate', cols: 80, rows: 24, write: false });
    await until(() => shown('duplicate').includes('echo: hello'));
    expect(shown('duplicate').match(/echo: hello/g)).toHaveLength(1);
  });
});
