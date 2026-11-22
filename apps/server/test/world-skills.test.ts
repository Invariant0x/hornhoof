/* Stage 7 server tests: world pack skills ON/OFF with zero traces, second modular test pack (Dungeon),
   company-wide CEO-only theme API & SSE sync, and absence of world voice in agent-to-agent messages,
   orchestrator talks, tasks, commit metadata, and external posts. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMPANY_THEME,
  containsWorldVoicePhrase,
  validateWorldPackBehavior,
  type WorldPackBehaviorSpec,
} from '@hornhoof/protocol/world';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, assistants, companies, departments, improvements, people, subscriptions, tasks } from '../src/db/schema.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
import { addressed, answerBy, wrote } from '../src/modules/conversation/prompt.js';
import { createWorldPackRegistry } from '../src/modules/world/packs/index.js';
import { DUNGEON_WORLD_PACK } from '../src/modules/world/packs/dungeon.js';
import { EGYPT_WORLD_PACK } from '../src/modules/world/packs/egypt.js';
import { placeSkills } from '../../node/src/skills.js';
import { ownFs } from '../../node/src/agent-fs.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

describe('Stage 7 world skills, voice channel boundaries, and company theme', () => {
  it('validates both Egypt and Dungeon world packs and proves engine/server core has zero hardcoded theme words', () => {
    expect(validateWorldPackBehavior(EGYPT_WORLD_PACK)).toEqual([]);
    expect(validateWorldPackBehavior(DUNGEON_WORLD_PACK)).toEqual([]);
    expect(EGYPT_WORLD_PACK.id).not.toBe(DUNGEON_WORLD_PACK.id);
    expect(EGYPT_WORLD_PACK.skills[0]!.id).not.toBe(DUNGEON_WORLD_PACK.skills[0]!.id);
    expect(EGYPT_WORLD_PACK.skills[0]!.voice!.samples.ru).not.toBe(DUNGEON_WORLD_PACK.skills[0]!.voice!.samples.ru);
    expect(EGYPT_WORLD_PACK.skills[0]!.voice!.samples.en).not.toBe(DUNGEON_WORLD_PACK.skills[0]!.voice!.samples.en);

    const coreFiles = [
      join(process.cwd(), '../../packages/protocol/src/world.ts'),
      join(process.cwd(), 'src/modules/agents/instructions.ts'),
      join(process.cwd(), 'src/modules/world/routes.ts'),
    ];
    for (const file of coreFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/\b(egypt|pharaoh|dungeon)\b/i);
      expect(content, file).not.toMatch(/повелитель|хранитель глубин/i);
    }
  });

  it('enforces one company-wide theme editable only by the CEO, visible to everyone, and broadcast live', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Engineering', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();

    const delegate = await invitePerson(app, ceo, {
      name: 'Clara',
      email: 'clara@acme.com',
      title: 'Delegate',
      access: { whole: true },
    });
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'clara@acme.com'));

    const wholeUser = await invitePerson(app, ceo, {
      name: 'Wes',
      email: 'wes@acme.com',
      title: 'COO',
      access: { whole: true },
    });
    const listedUser = await invitePerson(app, ceo, {
      name: 'Ann',
      email: 'ann@acme.com',
      title: 'Engineer',
      access: { departments: [dept!.id], teams: [] },
    });

    /* Unauthenticated access is refused. */
    expect((await app.inject({ url: '/api/world/theme' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'egypt' } })).statusCode).toBe(401);

    /* Default theme is cyberpunk across /api/world/theme, /api/me, and /api/org. */
    const initialCeo = await app.inject({ url: '/api/world/theme', ...as(ceo) });
    expect(initialCeo.statusCode).toBe(200);
    expect(initialCeo.json()).toEqual({ theme: DEFAULT_COMPANY_THEME, activePack: null, canEdit: true });
    expect((await app.inject({ url: '/api/me', ...as(listedUser) })).json().company.theme).toBe(DEFAULT_COMPANY_THEME);

    /* Non-CEO users (delegate, whole-company, listed) can read but never modify the company theme. */
    for (const [label, token] of [
      ['delegate', delegate],
      ['whole-company', wholeUser],
      ['listed', listedUser],
    ] as const) {
      const readRes = await app.inject({ url: '/api/world/theme', ...as(token) });
      expect(readRes.statusCode, label).toBe(200);
      expect(readRes.json().canEdit, label).toBe(false);
      const writeRes = await app.inject({
        method: 'PUT',
        url: '/api/world/theme',
        payload: { theme: 'egypt' },
        ...as(token),
      });
      expect(writeRes.statusCode, label).toBe(403);
    }

    /* Unknown theme is rejected with 400. */
    expect(
      (await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'atlantis' }, ...as(ceo) })).statusCode,
    ).toBe(400);

    /* CEO switches the company to Ancient Egypt: SSE broadcasts company_theme and org, and every member sees it. */
    const events: unknown[] = [];
    const stop = app.ctx.bus.subscribe(company!.id, m => events.push(m));
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/world/theme',
      payload: { theme: 'egypt' },
      ...as(ceo),
    });
    stop();

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({
      theme: 'egypt',
      activePack: {
        id: 'egypt',
        label: EGYPT_WORLD_PACK.label,
        skillIds: ['world-egypt-voice'],
      },
      canEdit: true,
    });
    expect(events).toContainEqual({ type: 'company_theme', theme: 'egypt' });
    expect(events).toContainEqual({ type: 'org' });

    for (const token of [ceo, delegate, wholeUser, listedUser]) {
      expect((await app.inject({ url: '/api/me', ...as(token) })).json().company.theme).toBe('egypt');
      expect((await app.inject({ url: '/api/org', ...as(token) })).json().company.theme).toBe('egypt');
    }
  });

  it('delivers Egypt world skills to workers, heads, orchestrator, and assistants via the standard skill pipeline and leaves zero traces when turned off', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [head] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'head',
        name: 'Dana',
        model: 'claude-opus-5-5',
        departmentId: dept!.id,
        roleKey: 'DEV-HEAD',
        skills: ['hh-lead-tasks'],
      })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Bruno',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        roleKey: 'DEV-ENG',
        skills: ['dev-tdd'],
      })
      .returning();
    const [orch] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [assistantPerson] = await db
      .insert(people)
      .values({
        companyId: company!.id,
        name: 'Ivan AI',
        title: 'Assistant',
        status: 'active',
        scopeKind: 'company',
        isOwner: false,
        isAgent: true,
        assistantOf: owner!.id,
      })
      .returning();
    const [assistantAgent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'assistant',
        name: 'Ivan AI',
        model: 'claude-sonnet-5-5',
      })
      .returning();
    await db.insert(assistants).values({
      companyId: company!.id,
      personId: assistantPerson!.id,
      agentId: assistantAgent!.id,
      program: 'openclaw',
    });

    const roster = [worker!, head!, orch!, assistantAgent!] as const;
    const before = await Promise.all(roster.map(a => instructionsOf(app.ctx, a)));
    const beforeWorkerCard = (await app.inject({ url: `/api/agents/${worker!.id}`, ...as(ceo) })).json();

    /* Turn Egypt ON. */
    const onRes = await app.inject({
      method: 'PUT',
      url: '/api/world/theme',
      payload: { theme: 'egypt' },
      ...as(ceo),
    });
    expect(onRes.statusCode).toBe(200);

    const during = await Promise.all(roster.map(a => instructionsOf(app.ctx, a)));
    for (let i = 0; i < roster.length; i++) {
      expect(during[i]!.text, roster[i]!.kind).toContain('<!-- hh:skill world-egypt-voice -->');
      expect(during[i]!.text, roster[i]!.kind).toContain('Да, повелитель');
      expect(during[i]!.text, roster[i]!.kind).toContain('Yes, my lord');
      expect(during[i]!.parts.some(p => p.kind === 'skill' && p.id === 'world-egypt-voice'), roster[i]!.kind).toBe(true);
      expect(during[i]!.hash, roster[i]!.kind).not.toBe(before[i]!.hash);
    }

    /* Agent Card shows the world skill as a locked cube alongside normal skills, and DB rows stay untouched. */
    const onWorkerCard = (await app.inject({ url: `/api/agents/${worker!.id}`, ...as(ceo) })).json();
    expect(onWorkerCard.skills).toContainEqual({
      id: 'world-egypt-voice',
      title: EGYPT_WORLD_PACK.skills[0]!.title,
      description: EGYPT_WORLD_PACK.skills[0]!.description,
      on: true,
      locked: true,
      overridden: false,
      templateChanged: false,
    });
    const [workerRowDuring] = await db.select().from(agents).where(eq(agents.id, worker!.id));
    expect(workerRowDuring!.skills).toEqual(['dev-tdd']);
    expect(workerRowDuring!.overrides).toEqual({});

    /* Attempting to toggle or override the world skill on an agent is rejected cleanly. */
    const toggleWorld = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${worker!.id}`,
      payload: { skills: { 'world-egypt-voice': false } },
      ...as(ceo),
    });
    expect(toggleWorld.statusCode).toBe(400);

    /* Turn Egypt OFF (back to cyberpunk): exact pre-world instructions, hash, card, and DB with ZERO traces. */
    const offRes = await app.inject({
      method: 'PUT',
      url: '/api/world/theme',
      payload: { theme: DEFAULT_COMPANY_THEME },
      ...as(ceo),
    });
    expect(offRes.statusCode).toBe(200);

    const after = await Promise.all(roster.map(a => instructionsOf(app.ctx, a)));
    for (let i = 0; i < roster.length; i++) {
      expect(after[i], roster[i]!.kind).toEqual(before[i]);
      expect(after[i]!.text, roster[i]!.kind).not.toMatch(/world-egypt-voice|повелитель|my lord/i);
    }
    const afterWorkerCard = (await app.inject({ url: `/api/agents/${worker!.id}`, ...as(ceo) })).json();
    expect(afterWorkerCard.skills).toEqual(beforeWorkerCard.skills);
    expect(afterWorkerCard.raw).toBe(beforeWorkerCard.raw);
  });

  it('places and completely cleans up file-based world skills via placeSkills on Claude and Codex/Antigravity folders', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Tank',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        roleKey: 'DEV-ENG',
        skills: ['dev-tdd'],
      })
      .returning();

    const packWithProcedure: WorldPackBehaviorSpec = {
      ...DUNGEON_WORLD_PACK,
      skills: [
        ...DUNGEON_WORLD_PACK.skills,
        {
          id: 'world-dungeon-etiquette',
          kind: 'procedure',
          title: { en: 'Dungeon hall etiquette', ru: 'Этикет залов подземелья' },
          description: { en: 'World procedure cube stored in skills folder.', ru: 'Процедурный навык мира в папке навыков.' },
          body: 'Use hall greetings only when welcoming humans to the tavern.',
        },
      ],
    };
    app.ctx.worldPacks = createWorldPackRegistry([EGYPT_WORLD_PACK, packWithProcedure]);

    const workDir = mkdtempSync(join(tmpdir(), 'hh-world-skills-'));
    try {
      const fs = ownFs;

      await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'dungeon' }, ...as(ceo) });
      const onInstructions = await instructionsOf(app.ctx, worker!);
      expect(onInstructions.skills.some(s => s.name === 'world-dungeon-etiquette')).toBe(true);

      for (const provider of ['claude', 'antigravity'] as const) {
        const subDir = join(workDir, provider);
        const folder = provider === 'claude' ? '.claude/skills' : '.agents/skills';
        await placeSkills(fs, subDir, provider, onInstructions.skills);
        const placedFile = await fs.read(join(subDir, folder, 'world-dungeon-etiquette', 'SKILL.md'));
        expect(placedFile).toContain('world-dungeon-etiquette');

        /* Turn world OFF and re-run placeSkills: world skill directory and manifest entry disappear completely. */
        await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'cyberpunk' }, ...as(ceo) });
        const offInstructions = await instructionsOf(app.ctx, worker!);
        expect(offInstructions.skills.some(s => s.name === 'world-dungeon-etiquette')).toBe(false);

        await placeSkills(fs, subDir, provider, offInstructions.skills);
        expect(await fs.kind(join(subDir, folder, 'world-dungeon-etiquette'))).toBeNull();
        const manifest = JSON.parse((await fs.read(join(subDir, '.hh-skills.json'))) ?? '{}') as { paths: string[] };
        expect(manifest.paths.some(p => p.includes('world-dungeon'))).toBe(false);

        /* Restore dungeon for next provider iteration. */
        await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'dungeon' }, ...as(ceo) });
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('plugs in the second test world pack (Dungeon) with its own distinct voice and swaps cleanly without traces', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Neo',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        roleKey: 'DEV-ENG',
        skills: ['dev-tdd'],
      })
      .returning();

    app.ctx.worldPacks = createWorldPackRegistry([EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]);

    /* Activate Dungeon pack. */
    const resDungeon = await app.inject({
      method: 'PUT',
      url: '/api/world/theme',
      payload: { theme: 'dungeon' },
      ...as(ceo),
    });
    expect(resDungeon.statusCode).toBe(200);
    expect(resDungeon.json().activePack.id).toBe('dungeon');

    const dungeonInstr = await instructionsOf(app.ctx, worker!);
    expect(dungeonInstr.text).toContain('<!-- hh:skill world-dungeon-voice -->');
    expect(dungeonInstr.text).toContain('Слушаюсь, хранитель глубин');
    expect(dungeonInstr.text).toContain('As you command, Keeper of the Deep');
    expect(dungeonInstr.text).not.toMatch(/world-egypt-voice|Да, повелитель|Yes, my lord/i);

    /* Swap Dungeon -> Egypt directly: zero Dungeon traces remain. */
    const resEgypt = await app.inject({
      method: 'PUT',
      url: '/api/world/theme',
      payload: { theme: 'egypt' },
      ...as(ceo),
    });
    expect(resEgypt.statusCode).toBe(200);
    const egyptInstr = await instructionsOf(app.ctx, worker!);
    expect(egyptInstr.text).toContain('<!-- hh:skill world-egypt-voice -->');
    expect(egyptInstr.text).not.toMatch(/world-dungeon-voice|хранитель глубин|Keeper of the Deep/i);
  });

  it('keeps world voice strictly out of agent-to-agent messages, orchestrator talks, tasks, commit metadata, and external posts for both Egypt and Dungeon', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db
      .insert(departments)
      .values({ companyId: company!.id, name: 'Development', templateKey: 'development', roleCode: 'DEV', position: 1 })
      .returning();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    const [devA] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Tank',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        subscriptionId: sub?.id ?? null,
        roleKey: 'DEV-ENG',
      })
      .returning();
    const [devB] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        kind: 'worker',
        name: 'Trinity',
        model: 'claude-sonnet-5-5',
        departmentId: dept!.id,
        subscriptionId: sub?.id ?? null,
        roleKey: 'DEV-REV',
      })
      .returning();
    const [orch] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));

    app.ctx.worldPacks = createWorldPackRegistry([EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]);

    for (const pack of [EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK] as const) {
      const setRes = await app.inject({
        method: 'PUT',
        url: '/api/world/theme',
        payload: { theme: pack.id },
        ...as(ceo),
      });
      expect(setRes.statusCode).toBe(200);

      /* 1. Agent-to-agent message and agent-to-orchestrator message stay plain service correspondence. */
      const peerEnvelope = addressed(
        `${wrote({ name: devA!.name, title: 'Developer' }, 'Branch task-1803 is ready for review.')}\n\n${answerBy({ id: devA!.id, name: devA!.name })}`,
        {
          from: { kind: 'agent', id: devA!.id, name: devA!.name, role: { en: 'Developer', ru: 'Разработчик' }, department: { id: dept!.id, name: { en: 'Development', ru: 'Разработка' } } },
          to: { kind: 'agent', id: devB!.id, name: devB!.name, role: { en: 'Code reviewer', ru: 'Ревьюер' }, department: { id: dept!.id, name: { en: 'Development', ru: 'Разработка' } } },
          channel: 'agent',
        },
      );
      expect(containsWorldVoicePhrase(peerEnvelope, pack), `${pack.id}: peer message`).toBe(false);

      const orchEnvelope = addressed(
        `${wrote({ name: devA!.name, title: 'Developer' }, 'Deployment check passed on commit abcdef1.')}\n\n${answerBy({ id: devA!.id, name: devA!.name })}`,
        {
          from: { kind: 'agent', id: devA!.id, name: devA!.name, role: { en: 'Developer', ru: 'Разработчик' }, department: { id: dept!.id, name: { en: 'Development', ru: 'Разработка' } } },
          to: { kind: 'orchestrator', id: orch!.id, name: orch!.name },
          channel: 'agent',
        },
      );
      expect(containsWorldVoicePhrase(orchEnvelope, pack), `${pack.id}: orchestrator message`).toBe(false);

      /* 2. Tasks, comments, and God's Word relocation tasks stay strictly neutral without world voice. */
      const taskRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          title: `Verify ${pack.id} build pipeline`,
          brief: 'Run unit and integration checks without style changes.',
          body: 'Check server build and API contract.',
          departmentId: dept!.id,
          assigneeAgentId: devA!.id,
        },
        ...as(ceo),
      });
      expect(taskRes.statusCode).toBe(201);
      const createdTask = taskRes.json().task;
      const commentRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${createdTask.id}/comments`,
        payload: { text: 'Checks green on latest revision.' },
        ...as(ceo),
      });
      expect(commentRes.statusCode).toBe(201);

      const relocRes = await app.inject({
        method: 'POST',
        url: '/api/world/relocations',
        payload: {
          buildingId: `house-${devA!.id}`,
          buildingKind: 'house',
          buildingLabel: 'Developer House',
          fromCol: 10,
          fromRow: 10,
          toCol: 14,
          toRow: 12,
          agentId: devA!.id,
          confirmed: true,
        },
        ...as(ceo),
      });
      expect(relocRes.statusCode).toBe(201);
      const [relocTask] = await db.select().from(tasks).where(eq(tasks.id, relocRes.json().task.id));
      for (const text of [createdTask.title, createdTask.brief, relocTask!.title, relocTask!.brief, relocTask!.body]) {
        expect(containsWorldVoicePhrase(text, pack), `${pack.id}: task text`).toBe(false);
      }

      /* 3. Git repository commit author metadata stays untouched by active world theme. */
      const repoRes = await app.inject({
        method: 'PUT',
        url: `/api/departments/${dept!.id}/repository`,
        payload: {
          url: 'https://github.com/invariant0x/hornhoof.git',
          branch: 'main',
          author: { name: 'Ivan Korol', email: 'ivan@acme.com' },
        },
        ...as(ceo),
      });
      expect(repoRes.statusCode).toBe(200);
      const [deptAfterRepo] = await db.select().from(departments).where(eq(departments.id, dept!.id));
      expect(deptAfterRepo!.repoAuthorName).toBe('Ivan Korol');
      expect(containsWorldVoicePhrase(deptAfterRepo!.repoAuthorName ?? '', pack), `${pack.id}: commit author`).toBe(false);

      /* 4. External post / feedback preview payload stays neutral without world voice. */
      const [finding] = await db
        .insert(improvements)
        .values({ companyId: company!.id, agentId: devA!.id, title: 'Clarify API timeout', text: 'Increase retry timeout.', scope: 'platform' })
        .returning();
      const previewRes = await app.inject({
        method: 'POST',
        url: '/api/feedback/preview',
        payload: { kind: 'bug', title: 'Clarify API timeout', text: 'Increase retry timeout.', improvement: finding!.id },
        ...as(ceo),
      });
      expect(previewRes.statusCode).toBe(200);
      expect(containsWorldVoicePhrase(JSON.stringify(previewRes.json()), pack), `${pack.id}: external post preview`).toBe(false);
    }
  });
});
