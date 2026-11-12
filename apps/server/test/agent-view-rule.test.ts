import { describe, expect, it } from 'vitest';
import { WHOLE, type Access } from '../src/auth/access.js';
import { hiddenParty, maskEnvelope, seesAgent, seesAgentId, type AgentViewer } from '../src/auth/agent-view.js';
import { seesTask, type TaskPlace } from '../src/modules/tasks/sight.js';

const listed = (departments: string[], teams: string[] = []): Access => ({ whole: false, departments: new Set(departments), teams: new Set(teams) });
const person = (access: Access, plans: string[] = ['mine'], agents: string[] = ['seen']): AgentViewer => ({ full: false, personId: 'me', access, plans: new Set(plans), agents: new Set(agents), own: new Set(), apart: new Set() });
const full: AgentViewer = { full: true, personId: 'ceo', access: WHOLE, plans: new Set(), agents: new Set(), own: new Set(), apart: new Set() };
const spot = { departmentId: 'dev' };

describe('who sees an agent', () => {
  it.each([
    ['own plan, department reached', 'mine', ['dev'], true],
    ['own plan, department out of reach', 'mine', ['sales'], false],
    ["someone else's plan, department reached", 'other', ['dev'], false],
    ["someone else's plan, department out of reach", 'other', ['sales'], false],
    ['no plan, department reached', null, ['dev'], false],
  ] as const)('%s', (_name, subscriptionId, departments, sees) => {
    expect(seesAgent(person(listed([...departments])), { subscriptionId, spot })).toBe(sees);
  });

  it("gives an assistant's own agent to the assistant's owner alone, whatever else they see", () => {
    const mine = { ...person(WHOLE), own: new Set(['ava']), apart: new Set(['max']) };
    const ceo = { ...full, apart: new Set(['ava', 'max']) };
    expect(seesAgent(mine, { subscriptionId: null, spot: { departmentId: null }, assistant: 'ava' })).toBe(true);
    expect(seesAgent(mine, { subscriptionId: 'mine', spot: { departmentId: null }, assistant: 'max' })).toBe(false);
    expect(seesAgent(ceo, { subscriptionId: 'mine', spot: { departmentId: null }, assistant: 'ava' })).toBe(false);
    expect(seesAgentId(ceo, 'ava')).toBe(false);
    expect(seesAgentId(ceo, 'anyone')).toBe(true);
  });

  it('gives the owner of a department every agent of it, its products and sub-units, on any plan or none, and nothing more', () => {
    const owner = { ...listed(['dev', 'sales']), owns: new Set(['dev']) };
    expect(seesAgent(person(owner), { subscriptionId: 'other', spot })).toBe(true);
    expect(seesAgent(person(owner), { subscriptionId: null, spot })).toBe(true);
    expect(seesAgent(person(owner), { subscriptionId: 'other', spot: { departmentId: 'shop', parentId: 'dev', teamId: null } })).toBe(true);
    expect(seesAgent(person(owner), { subscriptionId: 'other', spot: { departmentId: 'dev', teamId: 'web' } })).toBe(true);
    expect(seesAgent(person(owner), { subscriptionId: 'other', spot: { departmentId: 'sales' } })).toBe(false);
    expect(seesAgent(person(owner), { subscriptionId: 'mine', spot: { departmentId: 'sales' } })).toBe(true);
    expect(seesAgent(person(owner), { subscriptionId: 'other', spot: { departmentId: null } })).toBe(false);
  });

  it('counts having the whole company for no more than reach', () => {
    expect(seesAgent(person(WHOLE), { subscriptionId: 'other', spot })).toBe(false);
    expect(seesAgent(person(WHOLE), { subscriptionId: 'mine', spot })).toBe(true);
  });

  it('reaches a product through its department and by itself, and an agent without a department only with the whole company', () => {
    const product = { departmentId: 'shop', parentId: 'dev', teamId: null };
    expect(seesAgent(person(listed(['dev'])), { subscriptionId: 'mine', spot: product })).toBe(true);
    expect(seesAgent(person(listed(['shop'])), { subscriptionId: 'mine', spot: product })).toBe(true);
    expect(seesAgent(person(listed(['dev'])), { subscriptionId: 'mine', spot: { departmentId: null } })).toBe(false);
    expect(seesAgent(person(WHOLE), { subscriptionId: 'mine', spot: { departmentId: null } })).toBe(true);
  });

  it('judges by the plan it is given, for a program that runs on another than the card says', () => {
    const viewer = person(listed(['dev']));
    expect(seesAgent(viewer, { subscriptionId: 'mine', spot })).toBe(true);
    expect(seesAgent(viewer, { subscriptionId: 'moved', spot })).toBe(false);
  });

  it('gives the full view everything, and nobody an agent nobody names', () => {
    expect(seesAgent(full, { subscriptionId: null, spot: { departmentId: null } })).toBe(true);
    expect(seesAgentId(full, 'anyone')).toBe(true);
    expect(seesAgentId(person(WHOLE), 'seen')).toBe(true);
    expect(seesAgentId(person(WHOLE), 'other')).toBe(false);
    expect(seesAgentId(person(WHOLE), null)).toBe(false);
    expect(seesAgentId(person(WHOLE), undefined)).toBe(false);
  });
});

describe('who sees a task', () => {
  const task = (over: Partial<TaskPlace> = {}): TaskPlace => ({ departmentId: 'dev', productId: null, createdByPersonId: null, createdByAgentId: null, assigneeAgentId: null, executorAgentId: null, ...over });
  const viewer = person(listed(['dev']));

  const roles: [string, Partial<TaskPlace>][] = [
    ['assignee', { assigneeAgentId: 'seen' }],
    ['executor', { executorAgentId: 'seen' }],
    ['the agent who made it', { createdByAgentId: 'seen' }],
  ];

  it.each(roles)('goes with a seen agent as %s', (_name, over) => {
    expect(seesTask(viewer, task(over))).toBe(true);
    expect(seesTask(person(listed(['sales'])), task(over))).toBe(false);
  });

  it('goes with the person who gave it, and with nobody else who only reaches the department', () => {
    expect(seesTask(viewer, task({ createdByPersonId: 'me' }))).toBe(true);
    expect(seesTask(viewer, task({ createdByPersonId: 'someone', assigneeAgentId: 'other' }))).toBe(false);
    expect(seesTask(viewer, task())).toBe(false);
  });

  it('stays in the places the person reaches, even a task they gave', () => {
    expect(seesTask(person(listed(['sales'])), task({ createdByPersonId: 'me' }))).toBe(false);
    expect(seesTask(person(WHOLE), task({ departmentId: null, assigneeAgentId: 'seen' }))).toBe(true);
    expect(seesTask(viewer, task({ departmentId: null, assigneeAgentId: 'seen' }))).toBe(false);
    expect(seesTask(viewer, task({ departmentId: 'dev', productId: 'shop', assigneeAgentId: 'seen' }))).toBe(true);
  });

  it('shows the full view everything it reaches', () => {
    expect(seesTask(full, task())).toBe(true);
    expect(seesTask({ ...full, access: listed(['sales']) }, task())).toBe(false);
  });
});

describe('the other end of a message', () => {
  const party = (id: string | null, kind: 'agent' | 'person' | 'hornhoof' = 'agent', agentKind?: 'orchestrator' | 'head') => ({ kind, id, name: `Name ${id}`, role: { en: 'Role', ru: 'Роль' }, department: { id: 'dev', name: { en: 'Dev', ru: 'Dev' } }, ...(agentKind ? { agentKind } : {}) });

  it('says nothing of who it is, except that it is the orchestrator', () => {
    expect(hiddenParty(party('x', 'agent', 'head'))).toEqual({ kind: 'agent', id: null, name: 'Employee', role: null, department: null });
    expect(hiddenParty(party('x', 'agent', 'orchestrator'))).toEqual({ kind: 'agent', id: null, name: 'Employee', role: null, department: null, agentKind: 'orchestrator' });
  });

  it('leaves people, Hornhoof and seen agents as they are, and everything to the full view', () => {
    const message = { direction: 'in' as const, from: party('hidden'), to: party('seen'), senders: [party('hidden'), party('me', 'person'), party(null, 'hornhoof')] };
    const masked = maskEnvelope(person(WHOLE), message);
    expect(masked.from.id).toBeNull();
    expect(masked.to).toEqual(message.to);
    expect(masked.senders!.map(p => p.id)).toEqual([null, 'me', null]);
    expect(masked.senders![1]).toEqual(message.senders[1]);
    expect(masked.senders![2]).toEqual(message.senders[2]);
    expect(maskEnvelope(full, message)).toBe(message);
    expect(maskEnvelope(person(WHOLE), { direction: 'in', from: party('hidden'), to: party('seen') })).not.toHaveProperty('senders');
  });
});
