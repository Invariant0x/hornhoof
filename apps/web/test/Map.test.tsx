import { render, screen } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { orchestratorStatus, deptLayout, MapScreen } from '../src/screens/Map';
import type { SubView } from '../src/types';
import { mockApi, ORG, ORG_WITH_TEAMS, SUBS } from './api-mock';

const claude = SUBS[0]!;
const STATES: [string, SubView | null, string, string][] = [
  ['none', null, 'Needs a subscription to start', 'Чтобы начать, нужна подписка'],
  ['API key', SUBS[3]!, 'Runs on Anthropic key ending 9f3a', 'Работает на ключе Anthropic, последние символы 9f3a'],
  ['waiting for the machine', { ...claude, status: 'waiting_machine', online: false, machine: null }, "Waiting for Ivan's machine", 'Ждет машину, владелец Ivan'],
  ['needs login', { ...claude, status: 'needs_login' }, 'Waiting for the Claude login', 'Ждет входа в Claude'],
  ['ready and offline', { ...claude, online: false }, "Ivan's machine is offline", 'Машина не в сети, владелец Ivan'],
  ['ready and online', claude, "Runs on Ivan's Claude subscription", 'Работает на подписке Claude, владелец Ivan'],
];

describe('orchestratorStatus', () => {
  it.each(STATES)('says where the orchestrator runs: %s', (_, sub, english, russian) => {
    expect(orchestratorStatus(en, sub)).toBe(english);
    expect(orchestratorStatus(ru, sub)).toBe(russian);
  });
});

describe('Map', () => {
  it('shows the orchestrator, the company people and the empty state on first run', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen />);
    expect(await screen.findByText('No departments yet. Ask the orchestrator to create the first one.')).toBeInTheDocument();
    expect(container.querySelector('.hub-num')).toHaveTextContent('0/1');
    /* Only the count shows; the words are there for screen readers. */
    expect(screen.getByText('agents working')).toHaveClass('sr');
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(screen.getByText('Runs on Anthropic key ending 9f3a')).toBeInTheDocument();
  });

  it('fills the half gauge one segment of 24 per share of working agents', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 4, working: 1 } }] });
    const { container } = render(<MapScreen />);
    await screen.findByText('agents working');
    expect(container.querySelector('.hub-num')).toHaveTextContent('1/4');
    expect(container.querySelector('.gauge-bg')).toHaveAttribute('pathLength', '24');
    expect(container.querySelector('.gauge')).toHaveAttribute('pathLength', '6');
  });

  it('joins the people to the orchestrator with a trace, even before any department', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    const { container } = render(<MapScreen />);
    await screen.findByText('agents working');
    expect(container.querySelector('.wires [data-wire="people"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.wires .via')).toHaveLength(1);
  });

  it('places departments around the orchestrator, each on its own trace', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen />);
    expect(await screen.findByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.queryByText(/No departments yet/)).not.toBeInTheDocument();
    expect(container.querySelector('.wires [data-wire="d1"]')).toBeInTheDocument();
    expect(container.querySelector('.wires [data-wire="d2"]')).toBeInTheDocument();
  });

  it('sends no pulses while nobody exchanges messages', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    const { container } = render(<MapScreen />);
    await screen.findByText('Marketing');
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0);
  });

  it('moves the dot along the gauge while an agent works', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen />);
    await screen.findByText('agents working');
    expect(container.querySelector('.hub animateMotion')).toBeInTheDocument();
  });

  it('keeps the gauge still for a person who asks for less motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    mockApi({ 'GET /api/org': [200, { ...ORG, agents: { total: 1, working: 1 } }] });
    const { container } = render(<MapScreen />);
    await screen.findByText('agents working');
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0);
  });

  it('tells when the orchestrator has no subscription', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, orchestrator: { ...ORG.orchestrator, subscription: null } }] });
    render(<MapScreen />);
    expect(await screen.findByText('Needs a subscription to start')).toBeInTheDocument();
  });
});

describe('deptLayout', () => {
  it('routes every department at right angles from the hub to the middle of its near side, without overlaps', () => {
    const spots = deptLayout(7);
    const [hx, hy] = spots[0]!.path[0]!;
    for (const s of spots) {
      const [start, bend, ...rest] = s.path;
      expect(start).toEqual([hx, hy]);
      /* The first step leaves the hub on a 45 degree line, the rest run straight across or down. */
      expect(Math.abs(bend![0] - hx)).toBe(Math.abs(bend![1] - hy));
      let prev = bend!;
      for (const p of rest) {
        expect(p[0] === prev[0] || p[1] === prev[1]).toBe(true);
        prev = p;
      }
      const near = s.x + s.w / 2 < hx ? s.x + s.w : s.x;
      expect(prev).toEqual([near, s.y + s.h / 2]);
    }
    for (const a of spots)
      for (const b of spots)
        if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });
});
