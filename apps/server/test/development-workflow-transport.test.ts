import { describe, expect, it } from 'vitest';
import { fixture } from './review-fixture.js';

describe('development echelon transport compatibility', () => {
  it('exposes null echelons on a legacy task detail and preserves its owner and gates', async () => {
    const { task, author, reviewer, tools } = await fixture();
    const client = await tools();
    const result = await client.callTool({ name: 'task', arguments: { task: task.number } });
    expect(result.isError).not.toBe(true);
    const detail: unknown = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(detail).toMatchObject({
      id: task.id,
      echelons: null,
      stage: 0,
      gateCount: 1,
      assignee: { id: author.id },
      executor: { id: author.id },
      gates: [{ id: reviewer.id, state: 'next' }],
    });
  });

  it('exposes null echelons on legacy task list lines without inventing an echelon', async () => {
    const { task, author, tools } = await fixture();
    const client = await tools();
    const result = await client.callTool({ name: 'tasks', arguments: {} });
    expect(result.isError).not.toBe(true);
    const lines: unknown = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(lines).toEqual([
      expect.objectContaining({
        id: task.id,
        echelons: null,
        stage: 0,
        gateCount: 1,
        assignee: expect.objectContaining({ id: author.id }),
      }),
    ]);
  });
});
