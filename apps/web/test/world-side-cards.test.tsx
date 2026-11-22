import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { WorldSideCards, type WorldSelection } from '../src/screens/WorldSideCards';
import { buildDepartmentFocus } from '../src/world/department-focus';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation } from '../src/world/residents';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import { DEV_ORG, ME, mockApi } from './api-mock';

function buildFixtureScene() {
  const live = createHornhoofLiveFixture();
  const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 100 });
  const synced = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
  const sim = createResidentSimulation(EGYPT_WORLD_PACK, synced.city, live);
  return { live, synced, sim };
}

describe('Stage 8 WorldSideCards (all 6 entity cards + Department Mode)', () => {
  it('renders employee/house, subscription, machine, goal, statue, orchestrator, and department cards cleanly', () => {
    const { live, synced, sim } = buildFixtureScene();
    const enrichedLive = {
      ...live,
      subscriptions: live.subscriptions.map((s, idx) =>
        idx === 0 ? { ...s, resetsAt: '2026-11-22T18:30:00.000Z' } : s,
      ),
      goals: live.goals.map((g, idx) =>
        idx === 0
          ? {
              ...g,
              childGoalsTotal: 2,
              childGoalsReached: 1,
              childGoals: [
                { id: 'cg-1', number: 101, title: 'Ship core engine', status: 'reached' as const },
                { id: 'cg-2', number: 102, title: 'Ship Egypt theme UI', status: 'active' as const },
              ],
            }
          : g,
      ),
    };
    mockApi({
      'GET /api/agents/:id': [404, { error: { code: 'not_found', message: 'Not found' } }],
      'GET /api/agents/:id/events': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
    });

    const baseProps = {
      me: ME,
      org: DEV_ORG,
      snapshot: enrichedLive,
      departmentFocus: null,
      residents: sim.residents,
      wakeStatus: null,
      canRelocateBuilding: () => true,
      onClose: vi.fn(),
      onSelectAgent: vi.fn(),
      onSelectDepartment: vi.fn(),
      onWakeAgent: vi.fn(),
      onStartRelocate: vi.fn(),
      onOpenAgent: vi.fn(),
      onOpenOrchestrator: vi.fn(),
      onOpenTask: vi.fn(),
      onOpenGoal: vi.fn(),
      onOpenTracker: vi.fn(),
      onOpenTab: vi.fn(),
      onHire: vi.fn(),
    };

    /* 1. Employee / House card (level, task, simple quick chat, wake, open agent window). */
    const firstAgent = enrichedLive.agents.find(a => a.currentTask !== null) ?? enrichedLive.agents[0]!;
    const agentSel: WorldSelection = { kind: 'agent', agentId: firstAgent.id };
    const { rerender } = render(
      <LanguageProvider>
        <WorldSideCards {...baseProps} selection={agentSel} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'agent');
    expect(screen.getByTestId('world-card-level')).toHaveTextContent(`Lv ${firstAgent.level}`);
    expect(screen.getByTestId('world-agent-quick-chat')).toBeInTheDocument();

    /* 2. Subscription card (remaining limit, reset time, working agents). */
    const subBuilding = synced.city.buildings.find(b => b.kind === 'supply')!;
    const subId = subBuilding.entityId ?? enrichedLive.subscriptions[0]!.id;
    rerender(
      <LanguageProvider>
        <WorldSideCards {...baseProps} selection={{ kind: 'subscription', subscriptionId: subId, building: subBuilding }} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'subscription');
    expect(screen.getByTestId('world-sub-remaining')).toBeInTheDocument();

    /* 3. Machine hub card (connection, load, hosted agents). */
    const machineBuilding = synced.city.buildings.find(b => b.kind === 'district_hub')!;
    const machineId = machineBuilding.entityId ?? enrichedLive.machines[0]!.id;
    rerender(
      <LanguageProvider>
        <WorldSideCards {...baseProps} selection={{ kind: 'machine', machineId, building: machineBuilding }} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'machine');
    expect(screen.getByTestId('world-machine-load')).toBeInTheDocument();

    /* 4. Goal monument card (progress + subgoals list). */
    const goalBuilding = synced.city.buildings.find(b => b.kind === 'monument')!;
    const goalId = enrichedLive.goals[0]!.id;
    rerender(
      <LanguageProvider>
        <WorldSideCards {...baseProps} selection={{ kind: 'goal', goalId, building: goalBuilding }} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'goal');
    expect(screen.getByText(/Ship core engine/)).toBeInTheDocument();
    expect(screen.getByText(/Ship Egypt theme UI/)).toBeInTheDocument();

    /* 5. Statue card (department completed tasks + open department mode button). */
    const statueBuilding = synced.city.buildings.find(b => b.kind === 'statue')!;
    rerender(
      <LanguageProvider>
        <WorldSideCards
          {...baseProps}
          selection={{ kind: 'statue', departmentId: statueBuilding.departmentId!, building: statueBuilding }}
        />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'statue');
    expect(screen.getByTestId('world-statue-tasks')).toBeInTheDocument();

    /* 6. Orchestrator residence card (simple quick chat + open orchestrator). */
    const resBuilding = synced.city.buildings.find(b => b.kind === 'residence')!;
    rerender(
      <LanguageProvider>
        <WorldSideCards {...baseProps} selection={{ kind: 'orchestrator', building: resBuilding }} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'orchestrator');
    expect(screen.getByTestId('world-agent-quick-chat')).toBeInTheDocument();

    /* 7. Department Mode card (work-path legend, people, active tasks, pipeline, close). */
    const devDept = enrichedLive.departments[0]!;
    const focus = buildDepartmentFocus(synced.city, sim.residents, devDept.id, { departmentIndex: 0 });
    rerender(
      <LanguageProvider>
        <WorldSideCards
          {...baseProps}
          selection={{ kind: 'department', departmentId: devDept.id }}
          departmentFocus={focus}
        />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('world-side-card')).toHaveAttribute('data-card-kind', 'department');
    expect(screen.getByTestId('world-dept-workpaths')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps zero theme-specific words in WorldMapView, WorldSideCards and org-fallback', () => {
    const forbidden = /\b(egypt|pharaoh|nile|pyramid|obelisk|dungeon|papyrus)\b/i;
    for (const rel of ['src/screens/WorldMapView.tsx', 'src/screens/WorldSideCards.tsx', 'src/world/org-fallback.ts']) {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
      expect(forbidden.test(src), `unexpected theme word in ${rel}`).toBe(false);
    }
  });
});
