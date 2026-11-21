import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  agents,
  companies,
  departments,
  goals,
  jobs,
  machines,
  nodes,
  oneShotCalls,
  people,
  requests,
  subscriptions,
  tasks,
  teams,
} from '../src/db/schema.js';
import { cancel, report } from '../src/modules/tasks/engine.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

describe('Stage 4 live read-only world API and God\'s Word relocation', () => {
  it('requires authentication on all world routes', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    expect((await app.inject({ url: '/api/world/state' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/world/layout',
          payload: { packId: 'egypt', seed: 'hornhoof', layout: {} },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/world/relocations',
          payload: {
            buildingId: 'residence-main',
            buildingKind: 'residence',
            buildingLabel: 'Palace',
            fromCol: 10,
            fromRow: 10,
            toCol: 15,
            toRow: 15,
            confirmed: true,
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('reports empty_lot for a brand-new company without a template and no_subscription for a template without ready plans', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);

    /* Fresh empty company without template -> empty_lot (stakes, boards, starter tent). */
    const emptyRes = await app.inject({ url: '/api/world/state', ...as(ceo) });
    expect(emptyRes.statusCode).toBe(200);
    const emptyState = emptyRes.json();
    expect(emptyState.company.template).toBeNull();
    expect(emptyState.company.worldMode).toBe('empty_lot');
    expect(emptyState.company.allRestingNoSubscription).toBe(false);
    expect(emptyState.company.residenceStage).toBe(1);
    expect(emptyState.company.residenceTierKey).toBe('camp');
    expect(emptyState.departments).toHaveLength(0);

    /* Switch company onto a template with starter department + agent, and mark all plans unready -> no_subscription. */
    const [company] = await db.select().from(companies);
    await db.update(companies).set({ template: 'startup' }).where(eq(companies.id, company!.id));
    await db
      .update(subscriptions)
      .set({ status: 'needs_login' })
      .where(eq(subscriptions.companyId, company!.id));
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Engineering', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    await db.insert(agents).values({
      companyId: company!.id,
      kind: 'head',
      name: 'Morpheus',
      model: 'claude-opus-5-5',
      departmentId: dept!.id,
      roleKey: 'DEV-HEAD',
    });

    const noSubRes = await app.inject({ url: '/api/world/state', ...as(ceo) });
    expect(noSubRes.statusCode).toBe(200);
    const noSubState = noSubRes.json();
    expect(noSubState.company.worldMode).toBe('no_subscription');
    expect(noSubState.company.allRestingNoSubscription).toBe(true);
    expect(noSubState.departments[0].stage).toBe(1);
    expect(noSubState.agents.every((a: { resting: boolean; houseStage: number }) => a.resting && a.houseStage === 1)).toBe(true);
  });

  it('reads live Hornhoof entities strictly read-only with zero writes to any table, exact formulas, and excludes rework returns', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);

    /* Create 2 machines of different power, 2 subscriptions, 1 department, 2 agents, 2 goals, accepted + returned + cancelled tasks, and one-shot calls. */
    const [macSmall] = await db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: 'mac-small-key',
        hostname: 'small-box.local',
        cores: 4,
        memory: 8 * 1024 ** 3,
        reportAt: new Date(),
      })
      .returning();
    const [macBig] = await db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: 'mac-big-key',
        hostname: '0x.local',
        cores: 16,
        memory: 64 * 1024 ** 3,
        reportAt: new Date(),
      })
      .returning();

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const [subHealthy] = await db
      .insert(subscriptions)
      .values({
        companyId: company!.id,
        provider: 'claude',
        kind: 'personal',
        label: 'Claude Max',
        ownerPersonId: owner!.id,
        status: 'ready',
        limits: { status: 'allowed', windows: [{ name: '5h', utilization: 0.3, resetsAt: future }] },
        limitsUpdatedAt: new Date(),
      })
      .returning();
    const [subEmpty] = await db
      .insert(subscriptions)
      .values({
        companyId: company!.id,
        provider: 'codex',
        kind: 'personal',
        label: 'Codex Pro',
        ownerPersonId: owner!.id,
        status: 'ready',
        limits: { status: 'rejected', windows: [{ name: '5h', utilization: 1, resetsAt: future }] },
        limitsUpdatedAt: new Date(),
      })
      .returning();

    const [nodeBig] = await db
      .insert(nodes)
      .values({
        companyId: company!.id,
        machineId: macBig!.id,
        subscriptionId: subHealthy!.id,
        status: 'ready',
      })
      .returning();
    const [nodeSmall] = await db
      .insert(nodes)
      .values({
        companyId: company!.id,
        machineId: macSmall!.id,
        subscriptionId: subEmpty!.id,
        status: 'ready',
      })
      .returning();

    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();

    const [head] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'head',
        name: 'Morpheus',
        model: 'claude-opus-5-5',
        departmentId: dept!.id,
        subscriptionId: subHealthy!.id,
        nodeId: nodeBig!.id,
        roleKey: 'DEV-HEAD',
      })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Tank',
        model: 'gpt-6.1-sol',
        departmentId: dept!.id,
        subscriptionId: subEmpty!.id,
        nodeId: nodeSmall!.id,
        roleKey: 'DEV-IMPL',
      })
      .returning();

    /* Top-level numeric goal (active, 40%) + top-level goal with child goals (reached!). */
    const [goalNumeric] = await db
      .insert(goals)
      .values({
        companyId: company!.id,
        number: 1,
        title: 'Earn $1M ARR',
        responsiblePersonId: owner!.id,
        targetValue: 1_000_000,
        currentValue: 400_000,
        unit: 'USD',
        status: 'active',
      })
      .returning();
    const [goalParent] = await db
      .insert(goals)
      .values({
        companyId: company!.id,
        number: 2,
        departmentId: dept!.id,
        title: 'Ship Game Worlds',
        responsiblePersonId: owner!.id,
        status: 'reached',
      })
      .returning();
    await db.insert(goals).values({
      companyId: company!.id,
      number: 3,
      departmentId: dept!.id,
      parentGoalId: goalParent!.id,
      title: 'Sub-goal 1',
      responsiblePersonId: owner!.id,
      status: 'reached',
    });

    /* Seed 120 accepted tasks for Tank (Lv 10) + 15 rework/working tasks + 5 cancelled tasks ->
       ONLY the 120 'done' tasks may count toward level, department stage, statue progress, and residence stage! */
    const taskRows: (typeof tasks.$inferInsert)[] = [];
    for (let i = 1; i <= 120; i++) {
      taskRows.push({
        companyId: company!.id,
        number: i,
        departmentId: dept!.id,
        title: `Accepted #${i}`,
        status: 'done',
        assigneeAgentId: head!.id,
        executorAgentId: worker!.id,
        goalId: goalNumeric!.id,
        closedAt: new Date(),
      });
    }
    for (let i = 121; i <= 135; i++) {
      taskRows.push({
        companyId: company!.id,
        number: i,
        departmentId: dept!.id,
        title: `Returned rework #${i}`,
        status: 'working',
        assigneeAgentId: worker!.id,
        executorAgentId: worker!.id,
      });
    }
    for (let i = 136; i <= 140; i++) {
      taskRows.push({
        companyId: company!.id,
        number: i,
        departmentId: dept!.id,
        title: `Cancelled #${i}`,
        status: 'cancelled',
        assigneeAgentId: worker!.id,
        executorAgentId: worker!.id,
        closedAt: new Date(),
      });
    }
    const insertedTasks = await db.insert(tasks).values(taskRows).returning();

    /* Add 6 one-shot calls so flophouse rises to Stage 2. */
    const batchId = crypto.randomUUID();
    for (let i = 1; i <= 6; i++) {
      const [job] = await db
        .insert(jobs)
        .values({
          companyId: company!.id,
          subscriptionId: subHealthy!.id,
          agentId: worker!.id,
          taskId: insertedTasks[0]!.id,
          kind: 'call',
          prompt: `call ${i}`,
          timeoutMs: 1000,
          status: 'done',
        })
        .returning();
      await db.insert(oneShotCalls).values({
        companyId: company!.id,
        batch: batchId,
        number: i,
        jobId: job!.id,
        callerAgentId: worker!.id,
        taskId: insertedTasks[0]!.id,
        departmentId: dept!.id,
        brief: `helper ${i}`,
      });
    }

    /* Spy on every mutating method of Drizzle db during GET /api/world/state: must be ZERO writes! */
    const insertSpy = vi.spyOn(db, 'insert');
    const updateSpy = vi.spyOn(db, 'update');
    const deleteSpy = vi.spyOn(db, 'delete');

    const res = await app.inject({ url: '/api/world/state', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    insertSpy.mockRestore();
    updateSpy.mockRestore();
    deleteSpy.mockRestore();

    const state = res.json();
    expect(state.company.worldMode).toBe('active');
    expect(state.company.acceptedTasksTotal).toBe(120);
    expect(state.company.residenceStage).toBe(2);
    expect(state.company.residenceTierKey).toBe('mud_house');
    expect(state.company.oneShotCallsTotal).toBe(6);
    expect(state.company.flophouseStage).toBe(2);

    /* Machines -> districts sized by power. */
    const bigM = state.machines.find((m: { id: string }) => m.id === macBig!.id);
    const smallM = state.machines.find((m: { id: string }) => m.id === macSmall!.id);
    expect(bigM.hubSpan).toBe(4);
    expect(smallM.hubSpan).toBe(2);

    /* Agent Tank has 120 accepted tasks ONLY (not 140) -> Lv 10 (threshold 105 <= 120 < 126). */
    const tank = state.agents.find((a: { id: string }) => a.id === worker!.id);
    expect(tank.acceptedTasks).toBe(120);
    expect(tank.level).toBe(10);
    expect(tank.machineId).toBe(macSmall!.id);
    expect(tank.resting).toBe(true); /* Codex subscription is exhausted! */

    /* Department Development has 120 accepted tasks -> 1 statue at Stage 1 (every 100 tasks). */
    const devState = state.departments.find((d: { id: string }) => d.id === dept!.id);
    expect(devState.acceptedTasks).toBe(120);
    expect(devState.statues).toEqual([
      { index: 1, stage: 1, maxStage: 20, completed: false, sizeTier: 1, span: 1 },
    ]);

    /* Subscriptions -> fullness from remaining limits. */
    const healthyS = state.subscriptions.find((s: { id: string }) => s.id === subHealthy!.id);
    const emptyS = state.subscriptions.find((s: { id: string }) => s.id === subEmpty!.id);
    expect(healthyS.fullness).toBeCloseTo(0.7, 3);
    expect(healthyS.exhausted).toBe(false);
    expect(emptyS.fullness).toBe(0);
    expect(emptyS.exhausted).toBe(true);

    /* Top-level goals -> primary numeric pyramid (40%) and reached pyramid with celebration. */
    expect(state.goals).toHaveLength(2);
    const g1 = state.goals.find((g: { id: string }) => g.id === goalNumeric!.id);
    const g2 = state.goals.find((g: { id: string }) => g.id === goalParent!.id);
    expect(g1.isPrimary).toBe(true);
    expect(g1.progress).toBeCloseTo(0.4, 5);
    expect(g1.reached).toBe(false);
    expect(g2.reached).toBe(true);
    expect(g2.celebrating).toBe(true);
  });

  it('creates real small relocation tasks for department/agent/orchestrator and moves coordinates ONLY when accepted, staying on cancel', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [dev] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [mkt] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Marketing', templateKey: 'marketing', roleCode: 'MKT', position: 2 })
      .returning();
    const [devHead] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'head',
        name: 'Morpheus',
        model: 'claude-opus-5-5',
        departmentId: dev!.id,
        subscriptionId: plan!.id,
        roleKey: 'DEV-HEAD',
      })
      .returning();
    const [devWorker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Tank',
        model: 'claude-sonnet-5-5',
        departmentId: dev!.id,
        subscriptionId: plan!.id,
        roleKey: 'DEV-IMPL',
      })
      .returning();
    const [orchestrator] = await db
      .select()
      .from(agents)
      .where(eq(agents.kind, 'orchestrator'));

    /* Invite a person with access only to Marketing -> forbidden from relocating Development or Residence. */
    const mktPerson = await invitePerson(app, ceo, {
      name: 'Mkt Lead',
      email: 'mkt@acme.com',
      access: { departments: [mkt!.id] },
    });

    const deniedDept = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: `dept-${dev!.id}`,
        buildingKind: 'department',
        buildingLabel: 'Development',
        fromCol: 70,
        fromRow: 70,
        toCol: 76,
        toRow: 72,
        departmentId: dev!.id,
        confirmed: true,
      },
      ...as(mktPerson),
    });
    expect(deniedDept.statusCode).toBe(403);

    const deniedCommon = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: 'residence-main',
        buildingKind: 'residence',
        buildingLabel: 'Palace',
        fromCol: 75,
        fromRow: 75,
        toCol: 80,
        toRow: 78,
        confirmed: true,
      },
      ...as(mktPerson),
    });
    expect(deniedCommon.statusCode).toBe(403);

    /* Must require confirmed: true. */
    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: 'residence-main',
        buildingKind: 'residence',
        buildingLabel: 'Palace',
        fromCol: 75,
        fromRow: 75,
        toCol: 80,
        toRow: 78,
        confirmed: false,
      },
      ...as(ceo),
    });
    expect(unconfirmed.statusCode).toBe(400);

    /* 1. Department building -> assigned to department head (Morpheus), small: true. */
    const deptRel = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: `dept-${dev!.id}`,
        buildingKind: 'department',
        buildingLabel: 'Development',
        fromCol: 70,
        fromRow: 70,
        toCol: 76,
        toRow: 72,
        departmentId: dev!.id,
        confirmed: true,
      },
      ...as(ceo),
    });
    expect(deptRel.statusCode).toBe(201);
    const deptBody = deptRel.json();
    expect(deptBody.task.small).toBe(true);
    expect(deptBody.task.title).toBe('Перестроить Development');
    expect(deptBody.task.assigneeAgentId).toBe(devHead!.id);
    expect(deptBody.task.departmentId).toBe(dev!.id);
    expect(deptBody.relocation.status).toBe('pending');

    /* 2. Agent home -> assigned directly to the agent itself (Tank), small: true. */
    const houseRel = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: `house-${devWorker!.id}`,
        buildingKind: 'house',
        buildingLabel: 'Дом Tank',
        fromCol: 65,
        fromRow: 65,
        toCol: 68,
        toRow: 69,
        departmentId: dev!.id,
        agentId: devWorker!.id,
        confirmed: true,
      },
      ...as(ceo),
    });
    expect(houseRel.statusCode).toBe(201);
    const houseBody = houseRel.json();
    expect(houseBody.task.small).toBe(true);
    expect(houseBody.task.assigneeAgentId).toBe(devWorker!.id);

    /* 3. Common building (residence) -> assigned to orchestrator, small: true. */
    const commonRel = await app.inject({
      method: 'POST',
      url: '/api/world/relocations',
      payload: {
        buildingId: 'residence-main',
        buildingKind: 'residence',
        buildingLabel: 'Дворец',
        fromCol: 75,
        fromRow: 75,
        toCol: 82,
        toRow: 79,
        confirmed: true,
      },
      ...as(ceo),
    });
    expect(commonRel.statusCode).toBe(201);
    const commonBody = commonRel.json();
    expect(commonBody.task.small).toBe(true);
    expect(commonBody.task.assigneeAgentId).toBe(orchestrator!.id);
    expect(commonBody.task.departmentId).toBeNull();

    /* While tasks are still open, ALL 3 relocations remain 'pending' (coordinates have NOT moved). */
    const beforeDone = (await app.inject({ url: '/api/world/state', ...as(ceo) })).json();
    expect(beforeDone.relocations).toHaveLength(3);
    expect(beforeDone.relocations.every((r: { status: string }) => r.status === 'pending')).toBe(true);

    /* Accept Tank's house relocation task -> becomes 'applied'; cancel palace relocation task -> becomes 'cancelled'. */
    await report(app.ctx, devWorker!.id, houseBody.task.id, { summary: 'Order accepted and house relocated.', done: true });
    await cancel(app.ctx, { personId: (await db.select().from(people))[0]!.id }, commonBody.task.id, 'Changed mind');

    const afterState = (await app.inject({ url: '/api/world/state', ...as(ceo) })).json();
    const rDept = afterState.relocations.find((r: { taskId: string }) => r.taskId === deptBody.task.id);
    const rHouse = afterState.relocations.find((r: { taskId: string }) => r.taskId === houseBody.task.id);
    const rCommon = afterState.relocations.find((r: { taskId: string }) => r.taskId === commonBody.task.id);

    expect(rDept.status).toBe('pending');
    expect(rHouse.status).toBe('applied');
    expect(rHouse.toCol).toBe(68);
    expect(rHouse.toRow).toBe(69);
    expect(rCommon.status).toBe('cancelled');
  });

  it('projects Stage 5 live resident states (working, waiting_human, turn_failed + dept smoke, machine_offline, turnkey, activeCalls) strictly read-only', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));

    const [onlineMac] = await db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: 's5-online',
        hostname: 'online.local',
        cores: 8,
        memory: 32 * 1024 ** 3,
        reportAt: new Date(),
      })
      .returning();
    const [offlineMac] = await db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: 's5-offline',
        hostname: 'offline.local',
        cores: 4,
        memory: 8 * 1024 ** 3,
        reportAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning();

    const [onlineNode] = await db
      .insert(nodes)
      .values({ companyId: company!.id, machineId: onlineMac!.id, subscriptionId: plan!.id, status: 'ready' })
      .returning();
    const [offlineNode] = await db
      .insert(nodes)
      .values({ companyId: company!.id, machineId: offlineMac!.id, subscriptionId: plan!.id, status: 'ready' })
      .returning();

    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [tkTeam] = await db
      .insert(teams)
      .values({ companyId: company!.id, departmentId: dept!.id, name: 'Turnkey', turnkey: true })
      .returning();

    const [builder] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Builder',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        subscriptionId: plan!.id,
        nodeId: onlineNode!.id,
        roleKey: 'DEV-ENG',
      })
      .returning();
    const [waiter] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Waiter',
        model: 'gpt-6.1-sol',
        departmentId: dept!.id,
        subscriptionId: plan!.id,
        nodeId: onlineNode!.id,
        roleKey: 'DEV-REV',
      })
      .returning();
    const [failedAgent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'FailedWorker',
        model: 'claude-opus-5-5',
        departmentId: dept!.id,
        subscriptionId: plan!.id,
        nodeId: onlineNode!.id,
        roleKey: 'DEV-BE',
      })
      .returning();
    const [sleeper] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Sleeper',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        teamId: tkTeam!.id,
        subscriptionId: plan!.id,
        nodeId: offlineNode!.id,
        roleKey: 'DEV-ENG',
      })
      .returning();

    /* Builder running a task -> liveState 'working' + currentTask. */
    const [workTask] = await db
      .insert(tasks)
      .values({
        companyId: company!.id,
        number: 1,
        departmentId: dept!.id,
        title: 'Build Stage 5',
        status: 'working',
        assigneeAgentId: builder!.id,
        executorAgentId: builder!.id,
      })
      .returning();
    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: plan!.id,
      agentId: builder!.id,
      taskId: workTask!.id,
      kind: 'conversation',
      prompt: 'work',
      timeoutMs: 1000,
      status: 'running',
      startedAt: new Date(),
    });

    /* Waiter has an open human request -> liveState 'waiting_human'. */
    const [waitTask] = await db
      .insert(tasks)
      .values({
        companyId: company!.id,
        number: 2,
        departmentId: dept!.id,
        title: 'Need CEO choice',
        status: 'waiting',
        assigneeAgentId: waiter!.id,
      })
      .returning();
    await db.insert(requests).values({
      companyId: company!.id,
      taskId: waitTask!.id,
      agentId: waiter!.id,
      kind: 'question',
      audience: 'human',
      text: 'Choose option',
      status: 'open',
    });

    /* FailedWorker's last conversation turn failed -> liveState 'turn_failed' + dept.hasSmoke = true. */
    await db.insert(jobs).values({
      companyId: company!.id,
      subscriptionId: plan!.id,
      agentId: failedAgent!.id,
      taskId: workTask!.id,
      kind: 'conversation',
      prompt: 'fail',
      timeoutMs: 1000,
      status: 'failed',
      failure: { kind: 'crash', text: 'Process exited', retryable: false },
      finishedAt: new Date(),
    });

    /* Active one-shot call -> day-laborer listed in activeCalls. */
    const [callJob] = await db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: plan!.id,
        agentId: builder!.id,
        taskId: workTask!.id,
        kind: 'call',
        prompt: 'one-shot helper',
        timeoutMs: 1000,
        status: 'running',
        startedAt: new Date(),
      })
      .returning();
    await db.insert(oneShotCalls).values({
      companyId: company!.id,
      batch: crypto.randomUUID(),
      number: 1,
      jobId: callJob!.id,
      callerAgentId: builder!.id,
      taskId: workTask!.id,
      departmentId: dept!.id,
      brief: 'helper call',
    });

    const insertSpy = vi.spyOn(db, 'insert');
    const updateSpy = vi.spyOn(db, 'update');
    const deleteSpy = vi.spyOn(db, 'delete');
    const res = await app.inject({ url: '/api/world/state', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    insertSpy.mockRestore();
    updateSpy.mockRestore();
    deleteSpy.mockRestore();

    const state = res.json();
    const byId = new Map<string, Record<string, unknown>>(
      state.agents.map((a: Record<string, unknown>) => [String(a.id), a]),
    );
    expect(byId.get(builder!.id)).toMatchObject({
      model: 'claude-sonnet-5-5',
      roleClass: 'executor',
      archetype: 'builder',
      liveState: 'working',
      currentTask: { id: workTask!.id, number: 1, title: 'Build Stage 5' },
    });
    expect(byId.get(waiter!.id)).toMatchObject({
      roleClass: 'checker',
      liveState: 'waiting_human',
    });
    expect(byId.get(failedAgent!.id)).toMatchObject({
      liveState: 'turn_failed',
    });
    expect(byId.get(sleeper!.id)).toMatchObject({
      isTurnkey: true,
      roleClass: 'turnkey',
      liveState: 'machine_offline',
    });
    expect(state.departments[0].hasSmoke).toBe(true);
    expect(state.departments[0].hasStuckTask).toBe(true);
    expect(state.activeCalls).toHaveLength(1);
    expect(state.activeCalls[0].callerAgentId).toBe(builder!.id);
  });
});
