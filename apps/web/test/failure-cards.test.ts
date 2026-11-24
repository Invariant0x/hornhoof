import { expect, it } from 'vitest';
import { failureCards } from '../src/ui/FailureCards';
import type { Decisions } from '../src/types';

const counts = { byPerson: {}, byAgent: {}, total: 0 };

it('takes the machines away and the GitHub limits from the requests, and none from a server that sends neither', () => {
  const machine = { id: 'm1', hostname: 'a-host', owner: null, since: '2030-01-01T00:00:00.000Z', back: null, agents: 1, important: [] };
  const limit = { repository: 'acme/shop', resetAt: Date.UTC(2030, 0, 1, 23, 45) };
  const decisions = { requests: [], proposals: [], counts, machinesAway: [machine], githubLimits: [limit] } as unknown as Decisions;
  expect(failureCards(decisions)).toEqual({ machinesAway: [machine], githubLimits: [limit] });
  expect(failureCards({ requests: [], proposals: [], counts } as unknown as Decisions)).toEqual({ machinesAway: [], githubLimits: [] });
  expect(failureCards(undefined)).toEqual({ machinesAway: [], githubLimits: [] });
});
