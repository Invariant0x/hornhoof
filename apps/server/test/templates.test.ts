import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, LOCALES, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_SKILLS, orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { IssueInput } from '../src/modules/tasks/review-findings.js';
import { FIND, USE } from '../src/modules/tools/shelf.js';
import { CORE_SKILLS, HEAD_SKILLS, loadTemplates, MEMBER_SKILLS } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];

describe('templates', () => {
  const body = (id: string) => templates.skills.get(id)!.body;

  it('loads first contact instructions for starting the selected work', () => {
    expect(body('orch-interview')).toContain('first-contact');
    expect(body('orch-company')).toMatch(/stock structure[\s\S]*verify the resulting structure[\s\S]*department assignment operation/i);
    expect(body('orch-interview')).toMatch(/protected setup field[\s\S]*personal plan selection to its owner/i);
  });

  it('lets the home team carry out reversible device work the notebook allows', () => {
    expect(body('home-real-world-approval')).toMatch(/reversible[\s\S]*CE[O]['’]s yes/);
    for (const id of ['home-network', 'home-smart-control', 'home-work-pipeline']) {
      expect(body(id)).not.toMatch(/waits? for a person['’]s approval|Acting waits for a person/);
    }
  });

  it('loads the connected phone procedure for Operations', () => {
    expect(templates.roles.get('OPS-HEAD')!.skills).toContainEqual({ id: 'ops-phone-readiness', on: true, locked: true });
    expect(templates.roles.get('OPS-FIX')!.skills).toContainEqual({ id: 'ops-phone-readiness', on: true, locked: true });
    expect(templates.skills.get('ops-phone-readiness')?.body).toMatch(/Company phones[\s\S]*after an update/);
  });

  it('keeps role identities to one sentence and procedure-free across every department', () => {
    for (const role of roles) {
      expect(role.body, role.id).toMatch(/^You are [^\n.!?]+\.$/);
      expect(role.body, role.id).not.toMatch(/\b(?:must|never|submit|handoff|small: true|run_tests)\b|\b(?:dev|hh|orch)-[a-z-]+/);
    }
  });

  it('uses the existing design direction skill to keep generated pictures consistent and control their cost', () => {
    expect(templates.roles.get('DSN-UI')?.skills).toContainEqual(expect.objectContaining({ id: 'dsn-design-direction', on: true }));
    const direction = body('dsn-design-direction');
    expect(direction).toMatch(/generating pictures[\s\S]*one look[\s\S]*approved references[\s\S]*character sheets/i);
    expect(direction).toMatch(/compare the routes the company actually has[\s\S]*recommend the cheapest that meets the need[\s\S]*responsible person chooses/i);
    expect(direction).not.toMatch(/before pay-per-use/i);
    expect(direction).toMatch(/account holder authorizes it and the provider's terms do not forbid it[\s\S]*one job at a time[\s\S]*terms forbid[\s\S]*documented API or official connector/i);
    expect(direction).toMatch(/spending limit[\s\S]*for the order[\s\S]*maker's current prompt guide[\s\S]*model's structure/i);
    expect(direction).toMatch(/route, model, settings[\s\S]*actual cost[\s\S]*cost per accepted picture/i);
  });

  it('makes the design check compare the exact generated pictures with their approved references', () => {
    expect(body('dsn-work-pipeline')).toMatch(/exact generated pictures[\s\S]*approved references[\s\S]*size they will be shown/i);
    expect(body('dsn-brand-consistency')).toMatch(/generated pictures[\s\S]*approved references[\s\S]*character sheets/i);
  });

  it('keeps a decision on the original task when the person answers an existing question', () => {
    const lead = body('hh-lead-tasks');
    expect(lead).toContain('record_answer on the original request');
    expect(lead).toContain('Resume the existing task');
  });

  it('keeps deterministic testing in the testing policy and out of role identities', () => {
    expect(body('dev-testing-policy')).toMatch(/we test our program, not the operating system and not other programs/);
    expect(body('dev-testing-policy')).toMatch(/time in a test is virtual only/);
    for (const id of ['dev-testing-policy', 'dev-tdd', 'hh-run-checks', 'dev-e2e-tests']) {
      expect(body(id), id).not.toMatch(/superpowers|test-driven-development skill|condition-based-waiting/);
    }
    for (const role of roles) expect(role.body, role.id).not.toMatch(/we test our program/i);
  });

  it('keeps a shared machine, its shared browsers and a stale preparation from costing a check', () => {
    const policy = body('dev-testing-policy');
    expect(policy).toMatch(/Stop only processes you started, by their process id[\s\S]*`pkill`[\s\S]*other employees' checks/);
    expect(policy).toMatch(/shared browser folder[\s\S]*may be read-only: never install into it[\s\S]*run its test runner directly/);
    expect(policy).toMatch(/check out another commit or make a worktree[\s\S]*stale preparation, not a failed check/);
  });

  it('continues within current access and checks a failed write before retrying', () => {
    const flow = body('hh-task-flow');
    expect(flow).toMatch(/missing command or right[\s\S]*current access[\s\S]*authorized executor/i);
    expect(flow).toMatch(/read its state before retrying a write with an uncertain outcome/i);
  });

  it('keeps delegated work active and records a wait for a named person', () => {
    const flow = body('hh-task-flow');
    expect(flow).toMatch(/running checks[\s\S]*task dependencies in progress[\s\S]*owner and a timer/i);
    expect(flow).toMatch(/record a wait only when a named person/i);
  });

  it('connects a repository only once its branch holds a commit', () => {
    expect(body('orch-resources')).toMatch(/only once its branch exists with at least one commit[\s\S]*git ls-remote --heads[\s\S]*stops every turn of that department/);
  });

  it('lets the operator confirm a menu choice while keeping the session', () => {
    const operator = body('ops-program-operator');
    expect(operator).toMatch(/no visible selection[\s\S]*confirm the choice before sending Enter/i);
    expect(operator).toMatch(/keeping the current session[\s\S]*preserve work when compacting context/i);
    expect(body('ops-failure-review')).toMatch(/reasons Hornhoof recorded, the end of each blocked reason/);
  });

  it('makes each ability self-contained instead of relying on another selected skill', () => {
    const references = /\b(?:dev|dsn|fin|sup|ops|sal|mkt|biz|home|hh|orch)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
    for (const skill of skills) expect((skill.body.match(references) ?? []).filter(ref => !['hh-attach', 'hh-fetch', 'hh-browse', 'hh-xlsx'].includes(ref)), skill.id).toEqual([]);
  });

  it('keeps small work proportionate without waiving gates or permissions', () => {
    const lead = body('hh-lead-tasks');
    expect(lead).toMatch(/small: true[\s\S]*one place[\s\S]*clear result[\s\S]*no new dependency/);
    expect(lead).toMatch(/without extra splitting or separate gates unless risk or protected actions require them/);
    expect(lead).toMatch(/already working in that area[\s\S]*context/);
    expect(lead).toMatch(/several tasks ahead/);
    expect(lead).toMatch(/If scope grows[\s\S]*revise the task and check/);
    expect(body('hh-break-down')).toMatch(/required approvals/i);
    expect(body('hh-task-flow')).toMatch(/checks required by the assignment/i);
  });

  it('fits small work into its context and preserves a candidate already being checked', () => {
    expect(body('hh-lead-tasks')).toMatch(/before the final gate starts[\s\S]*holds its context[\s\S]*give the addition its own task/i);
    expect(body('hh-lead-tasks')).toMatch(/project's evidence cycle for small visual changes/i);
    expect(body('orch-plan-turn')).toMatch(/one accountable owner[\s\S]*independently acceptable results[\s\S]*handoff can be checked/i);
  });

  /* The flow of #883: a task goes to its department's head at once, the open turn of each top-level department is its next
     release, a task joins it as its result is accepted, and the tag of the release closes it by itself. */
  it('gives the department its release lifecycle and keeps later work moving', () => {
    const head = body('hh-head');
    expect(head).toMatch(/runs its own turns, one open at a time[\s\S]*next release/i);
    expect(head).toMatch(/joins it[^.]*as its result is accepted into the turn branch/);
    expect(head).toMatch(/release_turn[^.]*before main moves/);
    expect(head).toMatch(/tag[^.]*closes the turn by itself/);
    expect(body('orch-plan-turn')).toMatch(/add_tasks[\s\S]*as soon as the brief is clear[\s\S]*departments work in parallel/i);
    expect(body('dev-ci-release')).toMatch(/later work while CI checks the frozen candidate/i);
  });

  it('preserves named and urgent-only work and assigns unavailable required checks', () => {
    expect(body('orch-company')).toMatch(/Keep named orders in their units[\s\S]*urgent-only unit's assignment rule/);
    expect(body('orch-company')).toMatch(/route that can supply any required independent checker/);
    expect(body('dev-gates')).toMatch(/keep a required check open if no eligible checker is available/i);
  });

  it('selects implementation checks from the task and retains the four coding cycles', () => {
    for (const id of ['dev-task-flow', 'dev-tdd', 'dev-testing-policy', 'dev-implement']) expect(body(id), id).toMatch(/(?:task|head|owner)[\s\S]*check|check assigned/i);
    const tdd = body('dev-tdd');
    for (const kind of ['Bug', 'Known behaviour', 'Unknown path', 'Legacy code']) expect(tdd, kind).toContain(kind);
    expect(tdd).toContain('A characterization test of legacy code passes immediately, and that is correct');
    expect(tdd).toContain('requirement -> test');
    expect(tdd).toContain('verification before done');
    expect(tdd).toContain('no 80% coverage threshold');
    expect(body('dev-implement')).toMatch(/acceptance, risk class and task kind/);
    expect(body('dev-implement')).toMatch(/unknown path[\s\S]*acceptance check[\s\S]*spike/i);
  });

  it('keeps connected ownership and real dependencies in the assigned work', () => {
    expect(body('hh-lead-tasks')).toMatch(/a block is one result a person can check, with every part it needs\. Never split parts of one result between members/);
    expect(body('hh-lead-tasks')).toMatch(/No chains or `after` between members when one can do it/);
    expect(body('hh-break-down')).toMatch(/same files or records stay with that owner/);
    expect(body('hh-break-down')).toMatch(/plans, contracts or proofs/);
    expect(body('dev-lead')).toMatch(/one developer end to end/);
    expect(body('dev-lead')).toMatch(/one writer[\s\S]*only different features may go to different developers at once/);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE']) for (const skill of ['dev-tdd', 'dev-worktrees']) expect(templates.roles.get(id)!.skills.find(s => s.id === skill)?.on, `${id} ${skill}`).toBe(true);
  });

  it("has heads take a person's assistant's words as the person's own, with nothing left out", () => {
    const paragraph = body('hh-lead-tasks').split('\n').find(line => line.includes('"through the assistant"'));
    expect(paragraph).toMatch(/weigh them as you weigh that person's words in your window/);
    expect(paragraph).toMatch(/goes back to the assistant as plain text/);
    expect(paragraph).not.toMatch(/exception|never change|never hire/);
  });

  it('uses the incoming destination and sends to another channel only on request', () => {
    expect(body('hh-assistant')).toMatch(/delivery destination of the incoming message[\s\S]*tell_owner[\s\S]*when the owner asks/i);
  });

  it('creates repositories using a protected binding and delivers work in its declared form', () => {
    const resources = body('orch-resources');
    expect(resources).toMatch(/first repository[\s\S]*credential binding[\s\S]*vault reference/);
    expect(resources).toMatch(/account holder[\s\S]*protected setup/);
    expect(body('orch-company')).toMatch(/declared document or repository form/);
    expect(body('hh-task-flow')).toMatch(/document[\s\S]*attach[\s\S]*name no commit[\s\S]*when the department has a repository/);
    expect(body('hh-head')).toMatch(/keeps no repository[\s\S]*"tell_orchestrator"/);
  });

  it('keeps task tools and evidence separate from the role workflow', () => {
    for (const id of ['hh-task-flow', 'hh-head']) expect(body(id), id).toMatch(/record a wait only[\s\S]*named person/i);
    expect(body('hh-task-flow')).toMatch(/declared form[\s\S]*repository candidate[\s\S]*turnkey work[\s\S]*report/i);
    expect(body('hh-brief-members')).toContain('hh-attach --task N FILE');
    expect(body('hh-head')).toContain('Do not send the orchestrator a separate message repeating a task report');
    expect(body('hh-notebook')).toMatch(/only when[\s\S]*changes|when[\s\S]*changes/i);
  });

  it('bases compatibility and migration on actual data and deployed consumers', () => {
    expect(body('dev-engineering-rules')).toMatch(/persistent records[\s\S]*compatibility promises and rollback/i);
    expect(body('dev-plan-review')).toMatch(/deployed consumers[\s\S]*migration that preserves the data/i);
    expect(body('dev-plan-review')).toMatch(/Small or local work needs no note/);
  });

  it('checks upgrades and rollback in the review checklist', () => {
    const data = body('dev-review-diff').split('\n').find(line => line.startsWith('4. **Data.**'));
    expect(data).toMatch(/compatibility and rollback against the deployed readers and existing records/i);
    expect(data).toMatch(/coordinated writes consistent[\s\S]*untrusted input at its boundary/i);
  });

  it('offers removing what is not needed to reviewers and developers, off until someone turns it on', () => {
    for (const id of ['DEV-REV', 'DEV-ENG']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-cleanup')?.on, id).toBe(false);
  });

  it('keeps upstream attribution without shipping superseded engineering orders', () => {
    const rules = templates.skills.get('dev-engineering-rules')!;
    expect(rules.sources).toEqual(['unclebob/ub-mode SKILL.md']);
    expect(rules.body).toMatch(/exact checked result to the assigned destination/i);
    expect(rules.body).not.toMatch(/Every time you are asked to make a change follow:|Push to the main line at the end/i);
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    expect(sources).toMatch(/unclebob\/ub-mode's SKILL\.md at commit 3da62bf3fcfd2034de41f30d920d2739e566171f/);
    expect(sources).toMatch(/\| `skills\/dev-engineering-rules\.md` \| Original adaptation/);
  });

  it('changes approach when new evidence stops advancing the diagnosis', () => {
    expect(body('dev-debugging')).toMatch(/new supported hypothesis[\s\S]*evidence stops advancing/i);
    expect(body('orch-trouble')).toMatch(/new checks stop advancing/i);
    expect(body('hh-fix-loop')).toMatch(/new hypothesis supported by evidence/i);
  });

  it('retains all testing-policy capabilities without a fixed downstream tester', () => {
    const policy = body('dev-testing-policy');
    for (let n = 1; n <= 11; n++) expect(policy, `T${n}`).toContain(`T${n}:`);
    for (const rule of [/pure functions[\s\S]*direct fast tests/, /races, locks, permissions[\s\S]*real database/, /new test file always runs/i, /configuration failure or zero tests is not a pass/, /errors\/timeouts are not kills/, /money, access and security/, /executable rejection cases/, /diagnose unexpected results/i, /exact candidate\/fingerprint/, /measures validated for the project/, /NOT_RUN/]) expect(policy, String(rule)).toMatch(rule);
    expect(policy).toMatch(/does not assign a downstream tester/);
    expect(policy).toMatch(/full candidate validation[\s\S]*once for its candidate/);
    expect(policy).toMatch(/after a fix rerun failed and affected checks/);
    expect(policy).toMatch(/applicable coverage from a completed run/);
    expect(body('dev-review-verdict')).toContain('requirement -> test');
    expect(body('dev-review-verdict')).toMatch(/low coverage alone is not a finding/i);
  });

  it('uses comparable workloads and baselines for test performance', () => {
    const policy = body('dev-testing-policy');
    expect(policy).toMatch(/documented workload[\s\S]*comparable baseline[\s\S]*correctness does not depend on host speed/i);
    expect(body('dev-release-improvements')).toMatch(/comparable conditions[\s\S]*agreed baseline/i);
  });

  /* Task checks clogged the few check machines and slowed releases: a task's check runs only its own tests and its browser
     files in Chromium alone, as the repository's CI checks all three engines and everything else together for the release. */
  it("keeps a task's check to its own tests in Chromium, one run of a task at a time, and lets a running run finish", () => {
    const policy = body('dev-testing-policy');
    expect(policy).toMatch(/Our screens stay\.[^\n]*three engines stay[^\n]*task's check[^\n]*Chromium only[^\n]*Firefox and WebKit run in the repository's CI for the exact commit of a release/);
    expect(policy).toMatch(/T2: [^\n]*task's check[^\n]*runs only that task's files and the tests selected for them[^\n]*no whole suite and no extra parts/);
    expect(policy).toMatch(/T12: Let a running run finish\.[^\n]*small fix[^\n]*wait for its result and fix from it[^\n]*Stop a run only when it is broken[^\n]*wrong command[^\n]*wrong commit/);
    expect(policy).toMatch(/T13: [^\n]*at most one run[^\n]*queued or running/);
    expect(templates.skills.get('dev-testing-policy')!.description.en).toContain('T1 to T13');
    expect(body('hh-run-checks')).toMatch(/task's own run holds only its files and their tests[^.]*Chromium only[\s\S]*at most one run of a task queued or running[\s\S]*small fix[\s\S]*Stop only a broken run/);
    for (const id of ['dev-browser-check', 'dev-frontend-ui', 'dev-e2e-tests']) expect(body(id), id).toMatch(/Chromium only[^.]*Firefox and WebKit[^.]*repository's CI/);
  });

  it('keeps Security and red-team scopes distinct and uses task-assigned review and acceptance', () => {
    expect(templates.roles.get('DEV-RED')!.skills.map(s => s.id)).not.toContain('dev-threat-model');
    for (const id of ['DEV-RED', 'DEV-SEC']) {
      const role = templates.roles.get(id)!;
      expect(role.body, id).not.toMatch(/attack|hostile|exploit|steal/i);
    }
    expect(body('dev-adversarial')).toMatch(/only preview or sandbox builds your task names, never production and never real customer data/);
    expect(body('dev-threat-model')).toMatch(/trust boundaries[\s\S]*Name the safeguard[\s\S]*case with no safeguard is a finding/i);
    expect(body('dev-security-review')).toMatch(/Report only weak spots you confirmed in the code/);
    expect(body('dev-gates')).toMatch(/Review, Security and Tests run once each on the whole turn branch/);
    expect(body('dev-gates')).toMatch(/Tests verifies the exact final candidate including[\s\S]*repairs/);
    expect(body('dev-review-verdict')).toMatch(/only the fixes[\s\S]*paths they affect/);
    expect(body('dev-qa-acceptance')).toMatch(/exact candidate[\s\S]*do not assume[\s\S]*shared turn/);
    expect(body('dev-qa-acceptance')).toMatch(/Never pass something because the tests are green/);
  });

  it.each(['dev-security-review', 'dev-security-fix', 'dev-threat-model', 'dev-review-diff', 'dev-review-verdict', 'ops-credential-vault'])(
    '%s protects owner authority and still reports unintended disclosure',
    id => {
      expect(body(id)).toMatch(/orchestrator[\s\S]*unintended disclosure|unintended disclosure[\s\S]*owner access/i);
      expect(body(id)).not.toMatch(/what the orchestrator can see or do is never a finding/i);
    },
  );

  it('keeps Operations diagnosis scoped and plans checks for the actual risk', () => {
    expect(body('ops-intake')).toMatch(/database tool, which only reads[\s\S]*SQL and why/);
    expect(body('ops-intake')).toMatch(/trust boundaries[\s\S]*any required independent check/);
    expect(body('ops-incident-response')).toMatch(/route with the checks required for the permanent repair/);
    expect(body('ops-incident-response')).toMatch(/preserve logs, data and accounts/);
    expect(body('orch-trouble')).toMatch(/authorized execution route for code or schema changes/);
  });

  it('tells everyone that a reply in its window reaches only people, so an answer to an agent goes as a message', () => {
    const hornhoof = body('hh-hornhoof');
    expect(hornhoof).toMatch(/orchestrator and other employees [^.]*your reply here never reaches them/);
    expect(hornhoof).toMatch(/Answer one of them with "message_employee"/);
    expect(hornhoof).not.toMatch(/Answer in your reply or with/);
  });

  it('tells everyone that letters may wait in the inbox, how to read and mark them, and that a person\'s words never wait there', () => {
    const hornhoof = body('hh-hornhoof');
    expect(hornhoof).toMatch(/inbox/);
    expect(hornhoof).toMatch(/"inbox"[^.]*"inbox_mark"/);
    expect(hornhoof).toMatch(/A person's words never wait there\./);
    expect(hornhoof).not.toMatch(/\u2014/);
  });

  it("tells the orchestrator it clears any employee's inbox with a reason, and works on an open machine in any turn or tool step", () => {
    const trouble = body('orch-trouble');
    expect(trouble).toMatch(/Any employee's inbox is open to you[\s\S]*inbox and the employee's id in employee[\s\S]*inbox_mark[\s\S]*kind, source, task and receivedBefore[\s\S]*reason/);
    expect(trouble).toMatch(/goes in that employee's log with your name, the reason and how many letters/);
    expect(trouble).toMatch(/employees mark only their own letters/);
    const resources = body('orch-resources');
    expect(resources).toMatch(/Use computer in any turn or tool step, whoever started it/);
    expect(resources).not.toMatch(/runs only in a turn that answers/);
    for (const id of ['orch-trouble', 'orch-resources']) expect(body(id), id).not.toMatch(/[\u2014ё]/);
  });

  it('writes identifiers and evidence clearly in reports', () => {
    expect(body('hh-report-to-head')).toMatch(/identifiers, quantities and outcomes in separate readable words/);
  });

  it('releases an exact candidate with evidence and a tested rollback', () => {
    const release = body('dev-ci-release');
    expect(release).toMatch(/exact candidate[\s\S]*assigned checks passed/i);
    expect(release).toMatch(/prove rollback first/i);
    expect(release).toMatch(/exact checked candidate[\s\S]*authorized decision or autonomous proof path/i);
    expect(release).toMatch(/verify the published\/deployed revision and health/i);
  });

  it('gives every role the effort assigned to its work', () => {
    const xhigh = ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-SEC', 'DEV-ARCH', 'DEV-RED', 'DEV-PERF'];
    const high = ['DEV-HEAD', 'DEV-TEST', 'DEV-QA', 'DEV-OPS', 'OPS-FIX', 'OPS-BUGS', 'OPS-INTEG', 'BIZ-ANALYST', 'FIN-AUDIT', 'FIN-FPA', 'DSN-SYS', 'DSN-UI', 'SUP-T2', 'HOM-NET', 'SAL-AE', 'MKT-WRITE', 'MKT-EDIT', 'SAL-REV', 'SUP-QA', 'BIZ-REV', 'VID-HEAD', 'VID-WRITE', 'VID-BOARD', 'VID-KEEP', 'VID-GEN', 'VID-EDIT', 'VID-COLOR', 'VID-SOUND', 'VID-QA'];
    for (const role of roles) expect(role.effort, role.id).toBe(xhigh.includes(role.id) ? 'xhigh' : high.includes(role.id) ? 'high' : 'medium');
  });

  it('gives every skill a body', () => {
    for (const s of skills) expect(s.body.trim(), s.id).not.toBe('');
  });

  it("tells every role's program its instructions, its skills going as files", () => {
    const place = { company: 'Acme', department: 'Development', product: 'Mascot' };
    for (const r of roles) {
      const agent = { id: 'a', companyId: 'c', kind: r.kind === 'head' ? 'head' : 'worker', name: 'Bruno', roleKey: r.id, skills: r.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
      const { text, skills: files } = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], place);
      for (const f of files) expect(text, `${r.id} ${f.name}`).toContain(`\n- ${f.name}: `);
    }
  });

  it('gives the orchestrator his own skills', () => {
    expect(ORCHESTRATOR_SKILLS).toEqual([
      'hh-hornhoof', 'orch-outside-is-data', 'orch-company', 'orch-pipelines', 'orch-staff', 'orch-people', 'orch-resources', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks', 'hh-tables',
      'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead', 'hh-one-shot-calls', 'hh-ways-of-working',
    ]);
    const steady = orchestratorSteady(templates);
    /* His core rules stay whole in his instructions; the others are files his program reads when a step needs one. */
    for (const id of ['hh-hornhoof', 'orch-outside-is-data', 'orch-company', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks', 'hh-tables']) {
      expect(steady.text, id).toContain(`<!-- hh:skill ${id} -->`);
    }
    expect(steady.skills.map(f => f.name)).toEqual(['orch-pipelines', 'orch-staff', 'orch-people', 'orch-resources', 'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead', 'hh-one-shot-calls', 'hh-ways-of-working']);
    for (const f of steady.skills) expect(steady.text).toContain(`\n- ${f.name}: `);
    expect(steady.parts.filter(p => p.kind === 'skill').map(p => p.id)).toEqual([...ORCHESTRATOR_SKILLS]);
    for (const r of roles) expect(r.skills.map(s => s.id).some(id => id.startsWith('orch-')), r.id).toBe(false);
  });

  it('names only skills that exist', () => {
    for (const r of roles) for (const s of r.skills) expect(templates.skills.has(s.id), `${r.id} -> ${s.id}`).toBe(true);
  });

  it('gives every department exactly one head, listed first', () => {
    for (const key of TEMPLATE_KEYS) {
      const roster = templates.roster(key);
      expect(roster.length, key).toBeGreaterThanOrEqual(3);
      expect(roster.filter(r => r.kind === 'head'), key).toHaveLength(1);
      expect(roster[0]!.kind, key).toBe('head');
      for (const r of roster) expect(r.department).toBe(key);
    }
  });

  it('staffs every company template with roles that exist, one head per department', () => {
    for (const template of COMPANY_TEMPLATES) {
      for (const dept of template.departments) {
        const heads = dept.staff.filter(line => templates.roles.get(line.role)?.kind === 'head');
        expect(heads.length, `${template.key}: ${dept.template}`).toBe(1);
        for (const line of dept.staff) {
          const role = templates.roles.get(line.role);
          expect(role, `${template.key}: ${line.role}`).toBeDefined();
          expect(role!.department, `${template.key}: ${line.role} in ${dept.template}`).toBe(dept.template);
        }
      }
    }
  });

  it('counts the members of the turnkey teams of each department as its templates have them, for the card of a company template', () => {
    for (const dept of DEPARTMENT_TEMPLATES) {
      expect(dept.teamMembers, dept.key).toBe(templates.teamsOf(dept.key).reduce((n, t) => n + t.members.reduce((m, line) => m + line.count, 0), 0));
    }
  });

  it('names each role after its department code', () => {
    const codes: Record<string, string> = { operations: 'OPS', development: 'DEV', design: 'DSN', marketing: 'MKT', sales: 'SAL', business_development: 'BIZ', support: 'SUP', finance: 'FIN', home_devices: 'HOM', household: 'HHD', video_production: 'VID' };
    for (const r of roles) expect(r.id.startsWith(`${codes[r.department]}-`), r.id).toBe(true);
  });

  it('locks the core skills on for everyone, the task flow for members and the lead set for heads', () => {
    expect(HEAD_SKILLS).toContain('hh-lead-tasks');
    expect(MEMBER_SKILLS).toEqual(['hh-report-to-head', 'hh-task-flow']);
    for (const r of roles) {
      for (const id of CORE_SKILLS) expect(r.skills.find(s => s.id === id), `${r.id} ${id}`).toEqual({ id, on: true, locked: true });
      for (const [set, kind] of [[HEAD_SKILLS, 'head'], [MEMBER_SKILLS, 'member']] as const) {
        for (const id of set) {
          const s = r.skills.find(x => x.id === id);
          if (r.kind === kind) expect(s, `${r.id} ${id}`).toEqual({ id, on: true, locked: true });
          else expect(s, `${r.id} ${id}`).toBeUndefined();
        }
      }
      expect(new Set(r.skills.map(s => s.id)).size, r.id).toBe(r.skills.length);
    }
  });

  it('orders the gates a change passes in development, design and finance', () => {
    const gates = (key: 'development' | 'design' | 'finance') =>
      templates
        .roster(key)
        .filter(r => r.gate !== null)
        .sort((a, b) => a.gate! - b.gate!)
        .map(r => r.id);
    expect(gates('development')).toEqual(['DEV-REV', 'DEV-SEC', 'DEV-RED']);
    expect(gates('design')).toEqual(['DSN-QA']);
    expect(gates('finance')).toEqual(['FIN-AUDIT']);
    expect(templates.roles.get('DEV-REV')!.gate).toBe(1);
    expect(templates.roles.get('DEV-SEC')!.gate).toBe(2);
    expect(templates.roles.get('DEV-TEST')!.gate).toBeNull();
    for (const r of roles) if (r.kind === 'head') expect(r.gate, r.id).toBeNull();
  });

  it('reads role positions on the department schema, with ordinary work as the default', () => {
    expect(templates.roles.get('DEV-ARCH')!.schema).toBe('before_work');
    expect(templates.roles.get('DEV-TEST')!.schema).toBe('final_check');
    expect(templates.roles.get('DEV-PERF')!.schema).toBe('observer');
    expect(templates.roles.get('DEV-ENG')!.schema).toBeNull();
  });

  it('has a title and a description in every language of the registry, from its locale file', () => {
    for (const x of [...roles, ...skills]) {
      for (const { id: lang } of LOCALES) {
        expect(x.title[lang]?.length, `${x.id} title ${lang}`).toBeGreaterThan(1);
        expect(x.description[lang]?.length, `${x.id} description ${lang}`).toBeGreaterThan(5);
      }
      expect(x.title.ru, x.id).toMatch(/[а-я]/i);
    }
  });

  it('names where every template comes from and under which licence', () => {
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.md') && f !== 'SOURCES.md');
    expect(files.length).toBe(roles.length + skills.length + templates.teams.size + templates.echelons.size + templates.catalogs.size);
    for (const file of files) expect(sources, file).toContain(`| \`${file}\` |`);
    /* Every repository a skill learned from has its licence in the table of sources. */
    const repos = new Set([...sources.matchAll(/^\| ([\w.-]+\/[\w.-]+(?:, [\w.-]+\/[\w.-]+)*) \|/gm)].flatMap(m => m[1]!.split(', ')));
    for (const s of skills) for (const source of s.sources) expect(repos, `${s.id}: ${source}`).toContain(source.split(' ')[0]);
  });

  it('follows the copy rules: no em dashes and no \u0451', () => {
    for (const x of [...roles, ...skills]) {
      const text = [x.body, x.title.en, x.title.ru, x.description.en, x.description.ru].join('\n');
      expect(text, x.id).not.toMatch(/[\u2014\u0451\u0401]/);
    }
  });

  it('has a task watchdog and a failure collector in operations, each waking on its own timer with the tools to watch', () => {
    const ops = templates.roster('operations');
    expect(ops.filter(r => r.inDefault).map(r => r.id)).toEqual(['OPS-HEAD', 'OPS-INTEG', 'OPS-ACCT', 'OPS-FIX', 'OPS-WATCH', 'OPS-BUGS', 'OPS-PROGRAM', 'OPS-PM']);
    const watch = templates.roles.get('OPS-WATCH')!;
    const bugs = templates.roles.get('OPS-BUGS')!;
    expect([watch.timer?.minutes, bugs.timer?.minutes]).toEqual([10, 180]);
    /* Neither goes on a round while nothing is open or failed. */
    expect([watch.timer?.forWork, bugs.timer?.forWork]).toEqual([true, true]);
    expect(watch.skills.find(s => s.id === 'ops-task-watch')?.on).toBe(true);
    expect(bugs.skills.find(s => s.id === 'ops-failure-review')?.on).toBe(true);
    expect(templates.skills.get('ops-task-watch')!.grants).toEqual(['agents', 'hangs', 'message_employee', 'restart_program', 'settle']);
    expect(templates.skills.get('ops-failure-review')!.grants).toEqual(['failures', 'agents', 'message_employee', 'improvements']);
    expect(roles.filter(r => r.timer).map(r => r.id).sort()).toEqual(['BIZ-PM', 'DEV-PM', 'DSN-PM', 'FIN-PM', 'HHD-PM', 'HOM-PM', 'MKT-PM', 'OPS-BUGS', 'OPS-PM', 'OPS-WATCH', 'SAL-PM', 'SUP-PM', 'VID-PM']);
  });

  it('keeps the done rules for each kind of result in the watchdog skill and its role, in English with names and descriptions in both languages', () => {
    const skill = templates.skills.get('ops-task-watch')!;
    expect(skill.body).toMatch(/Code\. Done only when the task's commit is an ancestor of a release tag or of main/);
    expect(skill.body).toMatch(/task_released[\s\S]*never the turn number/i);
    expect(skill.body).toMatch(/only a turn branch or a branch of its own holds is unfinished work, and is never closed/);
    expect(skill.body).toMatch(/recorded where a colleague will find it[\s\S]*a path in the department's repository, or a file on the task/);
    expect(skill.body).toMatch(/If it is not recorded, the task is not done/);
    expect(skill.body).toMatch(/Coordination[\s\S]*every subtask is closed and it has no new work/);
    expect(skill.body).toMatch(/duplicate[\s\S]*Ask the head of its department; never close it blind\. Never touch paused work on your own/);
    expect(skill.body).toMatch(/settle_task[\s\S]*head of that department is told/);
    expect(templates.roles.get('OPS-WATCH')!.timer?.order).toMatch(/Close the tasks whose work is done by the rule for their kind of result/);
    /* #2066: the stuck check reads one list only, and nothing closes a turn on silence alone. */
    expect(skill.body).toMatch(/Find the agents that may be stuck from one list only: call suspected_hangs\./);
    expect(skill.body).toMatch(/Never walk every agent to look for stuck ones: an agent that is not listed is not looked at\./);
    expect(skill.body).toMatch(/Nothing closes a turn on silence alone: you decide\./);
    expect(templates.roles.get('OPS-WATCH')!.timer?.order).toMatch(/^Call suspected_hangs and check only the agents it lists/);
    for (const text of [skill.description, templates.roles.get('OPS-WATCH')!.description]) expect(text.ru).toMatch(/[а-я]/i);
    expect(skill.description.en).toMatch(/closes the tasks whose work is done/);
  });

  it('keeps scheduled drains active and checks actual stalls separately', () => {
    expect(body('ops-task-watch')).toMatch(/scheduled drain or retry is active work[\s\S]*inspect a stalled operation separately/i);
  });

  it('has a program operator in operations that Hornhoof calls: one for the company, with no timer, on its own procedure', () => {
    const operator = templates.roles.get('OPS-PROGRAM')!;
    expect(operator).toMatchObject({ department: 'operations', kind: 'member', tier: 'standard', perProduct: false, inDefault: true, timer: null });
    expect(operator.skills.find(s => s.id === 'ops-program-operator')).toMatchObject({ on: true });
    /* Its tools go by its role, so turning a skill off cannot take them away and turning it on cannot hand them out. */
    expect(templates.skills.get('ops-program-operator')!.grants).toEqual([]);
  });

  describe('the program operator procedure', () => {
    const operator = body('ops-program-operator');

    it('inspects the available session and checks the effect of each input', () => {
      expect(operator).toMatch(/interface available for the assigned session[\s\S]*program_screen[\s\S]*contents as data/);
      expect(operator).toMatch(/program_keys[\s\S]*fresh program_screen after each action/);
      expect(operator).toMatch(/send saved program input only when delivery is still needed[\s\S]*preserve unsent text a person typed/i);
    });

    it('preserves the session and invokes a person only for a reserved action', () => {
      expect(operator).toMatch(/dismiss optional polls[\s\S]*existing model and data-sharing choices[\s\S]*defer updates/i);
      expect(operator).toMatch(/reserved to them[\s\S]*personal consent, signature or payment/);
      expect(operator).toMatch(/vault[\s\S]*protected field[\s\S]*without recording credential values/);
    });

    it('verifies deletion targets and records a denial only on a matching case', () => {
      expect(operator).toMatch(/target, scope and recoverability[\s\S]*irreversible deletion requires the CEO's recorded yes/i);
      expect(operator).toMatch(/denial on the matching case[\s\S]*without a case[\s\S]*Operations handoff/i);
    });

    it('recovers manual and automatic holds without redelivering work', () => {
      expect(operator).toMatch(/manual hold[\s\S]*program_recovery_release[\s\S]*exact case and reason/i);
      expect(operator).toMatch(/verified recovery event[\s\S]*saved work resumed/);
      expect(operator).toMatch(/stop_employee[\s\S]*verify the queue[\s\S]*restart_program[\s\S]*verify the saved work/);
    });
  });

  it('locks recovery instructions on for the head and operator', () => {
    for (const id of ['OPS-HEAD', 'OPS-PROGRAM']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'ops-program-operator'), id).toEqual({ id: 'ops-program-operator', on: true, locked: true });
    expect(body('ops-intake')).toMatch(/never ask a person to stop a turn or write done/i);
  });

  it('has the orchestrator inspect a quiet screen and preserve progress', () => {
    expect(body('orch-trouble')).toMatch(/quiet screen calls for inspection[\s\S]*reliable progress[\s\S]*preserve the running turn/i);
    expect(body('orch-trouble')).toMatch(/recovery interface available for the target session[\s\S]*assigned operator/);
  });

  it('teaches the failure collector to file an improvement as a short case, part by part as the tool takes it', () => {
    const review = templates.skills.get('ops-failure-review')!.body;
    for (const part of ['title', 'problem', 'facts', 'source', 'guesses', 'why', 'change', 'gain']) expect(review, part).toContain(`${part}:`);
  });

  it('has a team of its own members in every department and keeps the video team on the checked route', () => {
    const teams = [...templates.teams.values()];
    expect(teams.map(team => team.department).sort()).toEqual([...new Set(roles.map(r => r.department))].sort());
    for (const team of teams) {
      /* Every department's team does its tasks whole, but the video team, which is on the checked route, and Development's, which takes only urgent work. */
      expect(team.turnkey, team.id).toBe(team.department !== 'video_production' && team.department !== 'development');
      expect(templates.teamsOf(team.department), team.id).toEqual([team]);
      expect(team.title.ru, team.id).toMatch(/[а-я]/i);
      expect(team.description.en.length, team.id).toBeGreaterThan(20);
      expect(team.members.length, team.id).toBeGreaterThan(0);
      for (const member of team.members) {
        expect(templates.roles.get(member.role), `${team.id}: ${member.role}`).toMatchObject({ department: team.department, kind: 'member' });
        expect(member.count, `${team.id}: ${member.role}`).toBeGreaterThan(0);
      }
      /* No id of a team is the id of a role. */
      expect(templates.roles.has(team.id), team.id).toBe(false);
    }
    expect(templates.teams.get('DEV-TEAM')).toMatchObject({ turnkey: false, urgentOnly: true, members: [{ role: 'DEV-ENG', count: 1 }] });
    expect(templates.teams.get('DEV-TEAM')!.title.en).toBe('Hotfix');
  });

  it('has the full development roster', () => {
    const dev = templates.roster('development');
    const ids = dev.filter(r => r.inDefault).map(r => r.id);
    /* The default roster has someone for every echelon: Architecture, Development, Review, Security and Tests. */
    expect(ids).toEqual(['DEV-HEAD', 'DEV-ARCH', 'DEV-ENG', 'DEV-REV', 'DEV-TEST', 'DEV-SEC', 'DEV-PM']);
    expect(dev.filter(r => !r.inDefault).map(r => r.id)).toEqual(['DEV-BE', 'DEV-FE', 'DEV-OPS', 'DEV-RED', 'DEV-QA', 'DEV-DOCS', 'DEV-PERF']);
    expect(templates.roles.get('DEV-FE')!.title).toEqual({ en: 'Interface developer', ru: 'Разработчик интерфейсов' });
    expect(templates.roles.get('DEV-BE')!.title).toEqual({ en: 'Backend engineer', ru: 'Бэкенд-разработчик' });
    expect(templates.roles.get('DSN-UI')!.perProduct).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
    for (const id of ['DEV-ARCH', 'DEV-REV']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules'), id).toBeUndefined();
    /* Each role asks for the strength of model its work needs: the strongest where nobody checks after and a mistake costs
       most, a strong one for whoever checks others or leads a department of risky work, the lightest for simple work that
       comes in a stream, and the middle one for everyone whose work is checked after. */
    const asked: Record<string, string[]> = {
      top: ['DEV-ARCH', 'DEV-SEC'],
      deep: ['BIZ-HEAD', 'BIZ-REV', 'DEV-HEAD', 'DEV-RED', 'DEV-REV', 'DSN-QA', 'FIN-AUDIT', 'FIN-HEAD', 'MKT-EDIT', 'SAL-REV', 'SUP-QA', 'VID-HEAD', 'VID-KEEP', 'VID-QA'],
      fast: ['BIZ-PM', 'DEV-PM', 'DSN-PM', 'FIN-PM', 'HHD-CAL', 'HHD-PM', 'HHD-SUPPLY', 'HOM-PM', 'MKT-PM', 'MKT-SOCIAL', 'OPS-PM', 'OPS-WATCH', 'SAL-PM', 'SAL-SDR', 'SUP-PM', 'SUP-T1', 'VID-PM'],
    };
    for (const role of templates.roles.values()) {
      const tier = Object.keys(asked).find(key => asked[key]!.includes(role.id)) ?? 'standard';
      expect(role.tier, role.id).toBe(tier);
    }
  });

  it.each(['DEV-ENG', 'DEV-REV', 'DEV-SEC'])('gives %s language and preparation guidance from the project', roleId => {
    const role = templates.roles.get(roleId)!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Bruno', roleKey: roleId, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    const rules = rendered.skills.find(s => s.name === 'dev-language-rules')!.body;
    expect(rules).toMatch(/declared toolchain[\s\S]*the repository's documented build/i);
    expect(rules).toMatch(/reuse compatible prepared dependencies when verified[\s\S]*prepare missing inputs/i);
    expect(rules).toMatch(/report a missing or unsupported capability/i);
  });

  it('credits every source a skill names in SOURCES.md', () => {
    const credits = readFileSync(`${DIR}/SOURCES.md`, 'utf8');
    for (const s of skills) for (const src of s.sources) expect(credits, `${s.id} ${src}`).toContain(src.split(' ')[0]);
  });

  it('allows browser installation for named workspace test files', () => {
    const check = templates.skills.get('dev-browser-check')!.body;
    expect(check).toMatch(/verify the browser opens/i);
    expect(check).toMatch(/install the browser there if needed/);
    expect(check).not.toMatch(/hornhoof/i);
    for (const item of [...roles, ...skills]) expect(item.body, item.id).not.toMatch(/npx playwright install/);
  });

  describe('scoped repair checks, author evidence and verified finding provenance', () => {
    const current = (): ReviewSkills => ({
      diff: templates.skills.get('dev-review-diff')!.body,
      verdict: templates.skills.get('dev-review-verdict')!.body,
      security: templates.skills.get('dev-security-review')!.body,
    });

    it('preserves scoped checks, T6/T10 evidence and provenance in the shipped skills', () => {
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, current())).toEqual([]);
      for (const id of ['dev-review-diff', 'dev-review-verdict']) expect(templates.skills.get(id)!.body, id).not.toMatch(/hornhoof/i);
    });

    it('rejects broken-meaning skills even when required substrings remain present', () => {
      const base = current();
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, base)).toEqual([]);
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nReturn each ordinary defect to the original author.` })).toContain('current-owner-repairs-and-model-choice');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nRequire a different provider before assigning Review.` })).toContain('current-owner-repairs-and-model-choice');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nOn a second look, read the whole patch again alongside reviewedCommit..fixCommit.` })).toContain('no-repeat-full-read-or-high');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nOn a second look, rerun your program's own review after reading reviewedCommit..fixCommit.` })).toContain('no-repeat-full-read-or-high');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nIn Claude Code run its code-review skill at high effort on every round.` })).toEqual(
        expect.arrayContaining(['native-review-first-look-only', 'no-repeat-full-read-or-high']),
      );
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, security: `${base.security}\nOn a second round, run codex review --base <main line> again.` })).toEqual(
        expect.arrayContaining(['native-review-first-look-only', 'no-repeat-full-read-or-high']),
      );
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nVerify testEvidence run and commitSha, then rerun the author's test runs to confirm.` })).toContain('t10-read-evidence-rerun-only-what-you-doubt');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nEven with harm to a person rules, low coverage alone is a blocking finding.` })).toContain('t6-named-harm-no-coverage-chasing');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nA reviewer's own verdict marks its findingId confirmed for provider counts.` })).toContain('structured-findings-and-provenance');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nAuthors of internal role or skill rules may take release approval on main when docs have no gates.` })).toContain(
        'no-self-or-role-rule-main-release-approval',
      );
    });
  });

  describe('mandatory UI panel wrapping, parallel non-visual work and dynamic language checks', () => {
    const uiBody = () => templates.skills.get('dev-frontend-ui')!.body;

    it('enables dev-frontend-ui by default on DEV-ENG and DEV-FE and satisfies every generic UI wrapping and language rule', () => {
      for (const roleId of ['DEV-ENG', 'DEV-FE'] as const) {
        expect(templates.roles.get(roleId)!.skills.find(s => s.id === 'dev-frontend-ui')?.on, roleId).toBe(true);
      }
      const browserCheck = templates.skills.get('dev-browser-check')!.body;
      /* How a view is built is in one skill, how it is checked in the other: together they hold every rule. */
      expect(failedRuleIds(FRONTEND_UI_RULES, `${uiBody()}\n${browserCheck}`)).toEqual([]);
      expect(uiBody()).not.toContain('dev-browser-check');
      expect(browserCheck).toMatch(/longest[\s\S]*shortest[\s\S]*shipped/i);
      expect(browserCheck).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
      const agentsDoc = readFileSync(join(DIR, '../AGENTS.md'), 'utf8');
      const contributingDoc = readFileSync(join(DIR, '../CONTRIBUTING.md'), 'utf8');
      for (const doc of [agentsDoc, contributingDoc]) {
        expect(doc).toContain('templates/skills/dev-frontend-ui.md');
        expect(doc).toContain('(docs/style-book.md)');
        expect(doc).toContain('packages/protocol/src/locales.ts');
        expect(doc).toMatch(/longest[\s\S]*shortest|shortest[\s\S]*longest/i);
        expect(doc).toMatch(/whole group|one group/i);
        expect(doc).toMatch(/explicit[\s\S]*browser default/i);
        expect(doc).toMatch(/scrollbar space/i);
        expect(doc).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
        expect(doc).not.toMatch(/Add screenshots in English and Russian/);
      }
      expect(agentsDoc).toContain('CONTRIBUTING.md#interface-panels-and-language-checks');
      expect(contributingDoc).toContain('### Interface panels and language checks');
    });

    it('ships the approved repository style book with matching theme tokens, existing source paths and dated exceptions', async () => {
      const root = join(DIR, '..');
      const styleBook = readFileSync(join(root, 'docs/style-book.md'), 'utf8');
      expect(styleBook).toContain('Version 1.4, approved by the head of Design on 2026-11-16.');
      const sizesSection = styleBook.slice(styleBook.indexOf('## 3. Spacing and sizes'), styleBook.indexOf('## 4. Components'));
      expect(sizesSection).toContain(
        '**RULE, all skins.** The frame, selection border and glow of an element follow its shape, cut corner included. A rectangular `box-shadow` or `outline` around a `clip-path` shape is not allowed',
      );
      expect(styleBook).toContain('| 1.4 | 2026-11-16 | Frame, selection and glow follow the cut corner in all skins, section 3 (#1070) | Head of Design |');
      expect(styleBook).not.toMatch(/[\u2014\u0451\u0401]/);
      for (const heading of [
        '## 1. Colours',
        '## 2. Type',
        '## 3. Spacing and sizes',
        '## 4. Components',
        '### Materials of a question',
        '## 5. Languages',
        '## 6. Text wrap and action groups',
        '## 7. Site and marketing',
        '## 8. Using and changing this book',
        '## 9. Browsers',
      ]) {
        expect(styleBook).toContain(heading);
      }
      const materialsSection = styleBook.slice(styleBook.indexOf('### Materials of a question'), styleBook.indexOf('### Tables'));
      expect(materialsSection).toContain('A material and an answer are never nested and never look alike.');
      expect(materialsSection).toContain('Opening, zooming, paging, closing and downloading choose nothing and send nothing.');
      expect(materialsSection).toContain('a picture takes the whole width of the option');
      expect(materialsSection).toContain('The viewer covers the window, follows the theme and keeps its close button on screen. A document reads to its end');
      expect(materialsSection).toContain('A refused or failed material keeps its name and says why in words.');
      expect(materialsSection).toContain('A download mark appears only on what can be downloaded.');
      expect(materialsSection).toContain('Built with the classes `.mat*`, `.mv*`, `.opt*` and `.answer-zone`. What each field means is decided with Development.');
      expect(styleBook).toContain('| 1.1 | 2026-11-06 | Rules for materials of a question | Head of Design |');
      expect(styleBook).toMatch(/ui\/Notebook\.tsx[\s\S]*Reviewed by 2027-02-05/);
      expect(styleBook).toMatch(/\.chip[\s\S]*Reviewed by 2027-02-05/);
      expect(styleBook).toMatch(/Close button of a panel[\s\S]*Reviewed by 2027-02-05/);
      const light = await skinTokens(root, 'light');
      const dark = await skinTokens(root, 'cyberpunk');
      const colourSection = styleBook.slice(styleBook.indexOf('## 1. Colours'), styleBook.indexOf('### Contrast of text'));
      const bookColours = Object.fromEntries(
        [...colourSection.matchAll(/^\| `(--[\w-]+)` \| `([^`]+)` \| `([^`]+)` \|/gm)].map(m => [m[1]!, [m[2]!, m[3]!]]),
      );
      expect(Object.keys(bookColours).length).toBeGreaterThanOrEqual(27);
      const actualColours = Object.fromEntries(Object.keys(bookColours).map(k => [k, [light[k], dark[k]]]));
      expect(actualColours).toEqual(bookColours);
      const typeSection = styleBook.slice(styleBook.indexOf('## 2. Type'), styleBook.indexOf('Fonts are imported'));
      const { '--cut-k': cut, ...bookFonts } = Object.fromEntries([...typeSection.matchAll(/^\| `(--[\w-]+)` \| `([^`]+)` \|/gm)].map(m => [m[1]!, m[2]!]));
      expect(Object.keys(bookFonts)).toEqual(['--f-display', '--f-body', '--f-mono']);
      /* The type table also holds how far the Light skin cuts its corners. */
      expect(cut).toBe(light['--cut-k']);
      const families = (fonts: Record<string, string | undefined>) => Object.fromEntries(Object.keys(bookFonts).map(k => [k, fontFamilies(fonts[k])]));
      expect(families(light)).toEqual(families(bookFonts));
      const sources = [...new Set(styleBookSources(styleBook))];
      expect(sources.length).toBeGreaterThanOrEqual(46);
      expect(sources.filter(rel => !existsSync(join(root, rel)))).toEqual([]);
    });

    it('rejects UI skill text that allows clipping, hiding button groups, blocking non-visual work or fixed/pseudo locales', () => {
      const base = `${uiBody()}\n${templates.skills.get('dev-browser-check')!.body}`;
      expect(failedRuleIds(FRONTEND_UI_RULES, base)).toEqual([]);
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhen a narrow panel overflows, truncate text with ellipsis to prevent horizontal scroll.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhen space runs short, hide secondary action buttons behind clipped overflow.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWrap action buttons one by one onto separate lines with custom per-row spacing.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWait on the design mockup before starting API, state logic or temporary skeleton work.`)).toContain(
        'parallel-nonvisual-visual-only-waits',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhile waiting on Design, invent custom spacing tokens for visual polish.`)).toContain(
        'parallel-nonvisual-visual-only-waits',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nCount a pseudo-locale or demo string as a shipped language during UI checks.`)).toContain(
        'multilang-and-dynamic-shipped-locales',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nAlways check a fixed two-language pair forever instead of measuring shipped translations.`)).toContain(
        'multilang-and-dynamic-shipped-locales',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nFollow Hornhoof's .notebook and theme.css rules in every company.`)).toContain(
        'project-reference-without-company-lockin',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nRely on browser default geometry and padding for icon buttons.`)).toContain(
        'explicit-component-geometry-and-scrollbar-space',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nAssume overlay scrollbars instead of reserving scrollbar space in scrollable panels.`)).toContain(
        'explicit-component-geometry-and-scrollbar-space',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nCount a single browser engine run as cross-engine verification.`)).toContain(
        'three-browser-engines-check',
      );
    });
  });

  describe('hh-questions shared skill and materials rule', () => {
    it('loads hh-questions as a core skill with an abstract English rule to attach materials via the question tool rather than prose paths', () => {
      const skill = templates.skills.get('hh-questions');
      expect(skill).toBeDefined();
      expect(skill!.kind).toBe('core');
      /* A rule on whom to ask is of use only to an employee who carries it, and every one of them asks. */
      expect(CORE_SKILLS).toContain('hh-questions');
      expect(skill!.grants).toEqual([]);
      expect(skill!.body).toMatch(/attach[\s\S]*materials[\s\S]*question tool[\s\S]*keep raw paths and content out/i);
      expect(skill!.body).toMatch(/inspect them before answering/i);
      const materialsLine = skill!.body.split('\n').find(line => line.includes('attach the materials')) ?? '';
      expect(materialsLine).not.toMatch(/\bhornhoof\b|#\d+|202\d-|@\S+\.\S+/i);
      expect(materialsLine).not.toMatch(/(?<=[a-z,;:]\s)[A-Z][a-z]+/);
    });
  });

  describe('shared remote check route, reconciled skill sources and head operational hold rules', () => {
    const runChecksBody = () => templates.skills.get('hh-run-checks')!.body;
    const leadTasksBody = () => templates.skills.get('hh-lead-tasks')!.body;
    /* A head carries the rules of leading, which the orchestrator shares, and those of a department's head, which come first. */
    const headBodies = () => `${templates.skills.get('hh-head')!.body}\n${leadTasksBody()}`;
    const orchestratorOutage = (): OrchestratorOutageSkills => ({ lead: leadTasksBody(), trouble: templates.skills.get('orch-trouble')!.body });
    const checkSources = (): ReconciledCheckSkills => ({
      tdd: templates.skills.get('dev-tdd')!.body,
      policy: templates.skills.get('dev-testing-policy')!.body,
      language: templates.skills.get('dev-language-rules')!.body,
      implement: templates.skills.get('dev-implement')!.body,
      browser: templates.skills.get('dev-browser-check')!.body,
      e2e: templates.skills.get('dev-e2e-tests')!.body,
      ciRelease: templates.skills.get('dev-ci-release')!.body,
    });

    it('locks abstract hh-run-checks on for every role and the orchestrator with zero extra grants or incident facts', () => {
      expect(CORE_SKILLS).toContain('hh-run-checks');
      expect(ORCHESTRATOR_SKILLS).toContain('hh-run-checks');
      const skill = templates.skills.get('hh-run-checks');
      expect(skill).toBeDefined();
      expect(skill!.kind).toBe('core');
      expect(skill!.grants).toEqual([]);
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, runChecksBody())).toEqual([]);
      for (const r of roles) {
        expect(r.skills.find(s => s.id === 'hh-run-checks'), r.id).toEqual({ id: 'hh-run-checks', on: true, locked: true });
      }
      expect(orchestratorSteady(templates).text).toContain(runChecksBody());
    });

    it('rejects broken-meaning hh-run-checks text even when required keywords remain present', () => {
      const base = runChecksBody();
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, base)).toEqual([]);
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nRun a directory locally during RED.`)).toContain('named-test-files-local-red-green');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nNever install dependencies locally.`)).toContain('local-lockfile-installs');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nCount a run_work dependency step as T2 check evidence.`)).toContain('noncheck-run-work-separate-from-mixed-checks');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nWhen run_tests is unavailable, fall back to running the whole suite locally.`)).toContain('unavailable-route-blocks-and-refusal-never-pass');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nTreat a command refusal as PASS once logged.`)).toContain('unavailable-route-blocks-and-refusal-never-pass');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nPatch Hornhoof task #42 for SampleMember on 2026-01-15.`)).toContain('abstract-english-no-incident-facts');
    });

    it('reconciles the development skills that run checks with run_tests while preserving project commands and screenshot rules', () => {
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, checkSources())).toEqual([]);
    });

    it('rejects contradictory local bulk-check instructions reintroduced into reconciled skills', () => {
      const base = checkSources();
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, base)).toEqual([]);
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, ciRelease: `${base.ciRelease}\nRun the whole suite locally.` })).toContain(
        'local-change-checks-and-remote-release-suite',
      );
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, policy: `${base.policy}\nSend author checks through run_tests.` })).toContain(
        'local-change-checks-and-remote-release-suite',
      );
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, browser: `${base.browser}\nTreat every Chromium screenshot capture as a full browser test suite.` })).toContain(
        'browser-suite-remote-light-screenshot-distinct',
      );
    });

    it('teaches every department head abstract external-outage hold recovery and orchestrator-authority forwarding', () => {
      expect(HEAD_SKILLS).toEqual(expect.arrayContaining(['hh-head', 'hh-lead-tasks']));
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, headBodies())).toEqual([]);
      for (const role of roles.filter(r => r.kind === 'head')) {
        const rendered = renderInstructions(
          templates,
          { id: 'h', companyId: 'c', kind: 'head', name: 'Hana', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1],
          { company: 'Acme', department: 'Work', product: null },
        );
        expect(rendered.text, role.id).toContain(leadTasksBody());
        expect(rendered.text, role.id).toContain(templates.skills.get('hh-head')!.body);
      }
    });

    it('rejects head instructions that prolong holds after recovery, freeze unrelated work or leak incident history', () => {
      const base = headBodies();
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, base)).toEqual([]);
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nKeep a general hold active after the external service recovers until each task asks again.`)).toContain(
        'outage-does-not-prolong-hold-and-lifts-at-once',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nFreeze all unrelated tasks across the department when one task hits a repeated local error.`)).toContain(
        'local-error-isolated-and-orchestrator-decisions-forwarded',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nHold orchestrator-level decisions in your own queue until the end of the turn.`)).toContain(
        'local-error-isolated-and-orchestrator-decisions-forwarded',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nRemember the GitHub push outage from SampleMember on #42 on 2026-01-15.`)).toContain(
        'abstract-head-rule-preserves-gates-and-dependencies',
      );
    });

    it('teaches the orchestrator abstract external-outage hold, one-action unhold and ordinary-retry rules while preserving safety rules', () => {
      const trouble = templates.skills.get('orch-trouble')!;
      expect(trouble.kind).toBe('procedure');
      expect(trouble.description.en).toMatch(/external service failures/i);
      expect(ORCHESTRATOR_SKILLS).toEqual(expect.arrayContaining(['hh-lead-tasks', 'orch-trouble']));
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, orchestratorOutage())).toEqual([]);
      expect(leadTasksBody().split('External outages and holds:').length - 1).toBe(1);
      expect(templates.skills.get('ops-api-connector')!.body).toContain('Never retry a payment or a send without first checking it did not already happen.');
      expect(templates.skills.get('dev-worktrees')!.body).toContain('Never force-push a shared branch');
      expect(templates.skills.get('hh-stay-in-scope')!.body).toContain('explicit boundaries');
      expect(templates.skills.get('hh-stay-in-scope')!.body).toMatch(/only irreversible deletion needs the CEO's recorded yes/i);
      expect(templates.skills.get('hh-stay-in-scope')!.body).not.toMatch(/irreversible or public waits/);
      expect(templates.skills.get('dev-ci-release')!.body).toMatch(/never skip, mute or retry a (?:failed )?check (?:merely )?to get green/i);
      expect(templates.skills.get('dev-testing-policy')!.body).toMatch(/do not retry or quarantine/i);
      expect(templates.skills.get('ops-task-watch')!.body).toMatch(/assign failed prerequisites to the owner who can repair them/i);
      for (const s of skills) {
        expect(s.body, s.id).not.toMatch(/\bexactly one attempt\b|\bno retries\b|\bdo not declare recovery\b/i);
      }
    });

    it('rejects orchestrator outage instructions that prolong holds, serialize recovery through a head queue, demand permission for ordinary retries, promise unshipped automation or leak incident history', () => {
      const base = orchestratorOutage();
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, base)).toEqual([]);
      const told = (line: string): OrchestratorOutageSkills => ({ ...base, trouble: `${base.trouble}\n${line}` });
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Keep a general hold active after the external service recovers.'))).toContain(
        'outage-not-grounds-for-longer-general-hold',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told("Send hold-lifting decisions one by one through a department head's queue."))).toContain(
        'orchestrator-decides-and-communicates-in-one-action',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Require permission before any ordinary retry, allow at most one attempt with no retries, and do not declare recovery.'))).toContain(
        'ordinary-retry-needs-no-permission-or-diagnosis-chain',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Remember the GitHub outage from SampleMember on #42 on 15.01.'))).toContain(
        'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('The server automatically retries git push in the background and blocks task creation in SQL.'))).toContain(
        'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
      );
    });

    it('teaches department heads abstract department-load ownership, independent after-chain slices and urgent-only team boundaries while keeping watchdog idle-fault rules intact', () => {
      const leadSkill = templates.skills.get('hh-lead-tasks')!;
      const breakDownSkill = templates.skills.get('hh-break-down')!;
      expect(leadSkill.description.en).toMatch(/keeps the department loaded/i);
      expect(breakDownSkill.description.en).toMatch(/independent parts[\s\S]*loaded/i);
      expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, { lead: leadSkill.body, breakDown: breakDownSkill.body })).toEqual([]);
      expect(templates.skills.get('ops-task-watch')!.body).toMatch(/runnable work has an eligible free owner/i);
    });

    it('rejects head breakdown instructions that treat idle capacity as normal, omit independentPart/independentNone, assign ordinary work to urgent-only teams or leak incident names', () => {
      const base: HeadLoadSkills = {
        lead: leadTasksBody(),
        breakDown: templates.skills.get('hh-break-down')!.body,
      };
      expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, base)).toEqual([]);
      const cases: [keyof HeadLoadSkills, string, string][] = [
        ['lead', 'Members standing free while work waits is a normal wait, and the head only orders tasks.', 'free-members-with-runnable-work-is-fault-and-head-owns-load'],
        ['breakDown', 'Leave after tasks without independentPart or independentNone, and send independentNone tasks out early.', 'after-chains-require-independent-part-or-none-preserving-boundaries'],
        ['lead', 'Assign ordinary non-urgent work to an urgentOnly team whenever peers are busy.', 'urgent-only-team-refuses-non-urgent-and-names-free-peers'],
        ['lead', 'Never give SampleSquad or SampleMember ordinary work on #42 after 2026-01-15.', 'abstract-no-incident-names-or-unshipped-idle-wake'],
        ['breakDown', 'Hornhoof wakes you automatically whenever two members stand free.', 'abstract-no-incident-names-or-unshipped-idle-wake'],
      ];
      for (const [key, badLine, ruleId] of cases) {
        expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, { ...base, [key]: `${base[key]}\n${badLine}` }), badLine).toContain(ruleId);
      }
    });
  });

  describe('mechanical finding category and strict behavior-unchanged boundary', () => {
    const pair = (): MechanicalSkills => ({
      diff: templates.skills.get('dev-review-diff')!.body,
      verdict: templates.skills.get('dev-review-verdict')!.body,
    });

    it('matches the IssueInput category enum and preserves the behavior-unchanged boundary', () => {
      const { diff, verdict } = pair();
      const expected = ['security', 'data', 'spec', 'other', 'mechanical'];
      expect(documentedCategories(verdict)).toEqual(expected);
      /* A category belongs to the verdict; the check itself knows nothing of it. */
      expect(diff).not.toMatch(/\bcategory\b|\bmechanical\b/i);
      for (const category of expected) {
        expect(IssueInput.safeParse({ category, blocking: true, path: 'src/index.ts', line: 1, harm: 'Wrong behaviour.' }).success, category).toBe(true);
      }
      for (const invented of ['style', 'lint', 'medium']) {
        expect(IssueInput.safeParse({ category: invented, blocking: true, path: 'src/index.ts', line: 1, harm: 'Wrong behaviour.' }).success, invented).toBe(false);
      }
      expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, { diff, verdict })).toEqual([]);
    });

    it('rejects review skill text that broadens mechanical to behavioral changes, mixed verdicts, mid-turn effort switches or incident facts', () => {
      const base = pair();
      expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, base)).toEqual([]);
      const violations: [keyof MechanicalSkills, string, string][] = [
        ['verdict', "Classify a public API rename as 'mechanical' when tests compile.", 'strict-behavior-unchanged-boundary'],
        ['diff', "Use 'mechanical' when a fix may change behaviour only slightly.", 'strict-behavior-unchanged-boundary'],
        ['verdict', "When in doubt, mark the finding 'mechanical' so the fix finishes faster.", 'doubt-keeps-regular-category-and-full-base-level'],
        ['diff', "Classify spec findings as 'mechanical' to run at medium.", 'doubt-keeps-regular-category-and-full-base-level'],
        ['verdict', 'Set Wake.mechanical on mixed verdicts whenever one issue is mechanical.', 'same-owner-repair-without-effort-or-return'],
        ['diff', 'Switch effort inside a running turn once a mechanical issue appears.', 'same-owner-repair-without-effort-or-return'],
        ['verdict', "Open a second review for 'mechanical' findings after submission.", 'same-owner-repair-without-effort-or-return'],
        ['diff', 'Added for Hornhoof task #42 by SampleMember on 2026-01-15.', 'abstract-english-no-incident-or-company-leaks'],
      ];
      for (const [target, extra, expectedRule] of violations) {
        expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, { ...base, [target]: `${base[target]}\n${extra}` }), extra).toContain(expectedRule);
      }
    });
  });
});

type ReviewSkills = { diff: string; verdict: string; security: string };

const NATIVE_TOOL_RE = /review facility|code-review skill|security-review skill|codex review --base|review-agent/i;

const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\n+/).map(line => line.trim()).filter(Boolean);

const clausesOf = (text: string): string[] =>
  text.split(/[.!?;,\n]+|\b(?:then|but|however|yet)\b/i).map(clause => clause.trim()).filter(Boolean);

const negatesBefore = (clause: string, target: RegExp): boolean => {
  const hit = target.exec(clause);
  return !hit || /\b(never|not|don't|cannot|forbid\w*|skip\w*|without|instead of|no|neither|nor)\b/i.test(clause.slice(0, hit.index));
};

const forbids = (text: string, target: RegExp): boolean =>
  clausesOf(text).every(clause => negatesBefore(clause, target));

const scopesFirstLook = (sentence: string): boolean =>
  /\bfirst look\b/i.test(sentence) && !/\b(?:second (?:look|round)|every round)\b/i.test(sentence);

const allowsNativeMention = (sentence: string): boolean =>
  scopesFirstLook(sentence) || forbids(sentence, NATIVE_TOOL_RE);

const nativeReviewScoped = (text: string): boolean => {
  const mentions = sentencesOf(text).filter(s => NATIVE_TOOL_RE.test(s));
  return mentions.some(scopesFirstLook) && mentions.every(allowsNativeMention);
};

const secondLookSentences = (s: ReviewSkills): string =>
  sentencesOf(`${s.diff}\n${s.verdict}\n${s.security}`).filter(line => /\b(?:second (?:look|round)|fixReview)\b/i.test(line)).join('\n');

const REVIEW_CONTRACT_RULES: { id: string; holds: (s: ReviewSkills) => boolean }[] = [
  {
    id: 'current-owner-repairs-and-model-choice',
    holds: s => /actual task route/.test(s.verdict) && /Review is required for executable results on the Development route/.test(s.verdict) &&
      /failed verdict keeps ownership with you/.test(s.verdict) && /independence and capability the route requires/.test(s.verdict) &&
      /same provider is the available choice/.test(s.verdict) &&
      forbids(s.verdict, /\breturn\w*\b[^.!?;,]*\b(?:original author|work to the author)\b/i) &&
      forbids(s.verdict, /\brequire\w*\b[^.!?;,]*\bdifferent provider\b/i),
  },
  {
    id: 'native-review-first-look-only',
    holds: s => nativeReviewScoped(s.diff) && nativeReviewScoped(s.security),
  },
  {
    id: 'no-repeat-full-read-or-high',
    holds: s => {
      const all = `${s.diff}\n${s.verdict}\n${s.security}`;
      const repeats = secondLookSentences(s);
      return (
        /\bfirst look\b/i.test(all) &&
        forbids(all, /\b(?:at|on|force|forcing|raise\s+effort\s+to)\s+high(?:\s+effort)?\b/i) &&
        forbids(repeats, /\b(?:read|reread|re-read|inspect|review)\b[^.!?;,]*\b(?:whole|entire|full)\s+(?:patch|change|branch|diff)\b/i) &&
        forbids(repeats, /\b(?:(?:re-?)?run\w*|use|invoke|repeat\w*)\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:program's own review|native review|code-review|security-review|codex review|review-agent)\b/i) &&
        /On recheck, inspect the fixes and the behavior they affect/i.test(s.diff) &&
        /\b(?:do not|never|skip|without|no second)\b[^.!?]*\b(?:program's own review|native review|whole (?:patch|change|branch))\b/i.test(s.verdict)
      );
    },
  },
  {
    id: 't6-named-harm-no-coverage-chasing',
    holds: s =>
      /\bharm to a person\b/i.test(s.diff) &&
      forEvery([s.verdict], text => /\bharm to a person\b/i.test(text) && /\blow coverage alone is not a finding\b/i.test(text)) &&
      forbids(`${s.diff}\n${s.verdict}`, /\blow coverage(?:\s+alone)?\s+(?:blocks|counts as a finding|is a (?:blocking )?finding)\b/i),
  },
  {
    id: 't10-read-evidence-rerun-only-what-you-doubt',
    holds: s =>
      /\bcompleted results for the reviewed commit\b/.test(s.diff) &&
      /\b(?:instead of rerunning|do not rerun|never rerun)\b/i.test(s.diff) &&
      /author's description of the local checks they ran[^.]*rerun what you doubt in your own workspace/.test(s.verdict) &&
      forbids(`${s.diff}\n${s.verdict}\n${s.security}`, /\b(?:re-?run\w*|re-?execut\w*)\b[^.!?;,]*\b(?:author'?s?\s+|submitted\s+|its\s+)?test(?:\s+runs?|\s+suites?|s)\b/i),
  },

  {
    id: 'structured-findings-and-provenance',
    holds: s =>
      /\breviewedCommit\b/.test(s.verdict) &&
      /\bissues\b/.test(s.verdict) &&
      /\bfindingId\b/.test(s.verdict) &&
      /\bconfirm_finding\b/.test(s.verdict) &&
      /\bfixCommit\b/.test(s.verdict) &&
      /\breviewerVendor\b/.test(s.verdict) &&
      /\bcandidateId\b/.test(s.verdict) && /\bstage\b/.test(s.verdict) &&
      /\bdoes not\b[^.!?]*\b(?:fixed|APPROVE)\b/i.test(s.verdict) &&
      forbids(`${s.diff}\n${s.verdict}`, /\b(?:mark\w*|confirm\w*|count\w*)\b[^.!?;,]*\bfindingId\s+confirmed\b/i),
  },
  {
    id: 'no-self-or-role-rule-main-release-approval',
    holds: s =>
      /\binternal role or skill rules\b[^.!?]*\bnever\b[^.!?]*\b(?:main|release) approval\b/i.test(s.verdict) &&
      forbids(`${s.diff}\n${s.verdict}`, /\b(?:may|can)\s+(?:take|grant|claim)\b[^.!?;,]*\b(?:main|release)\s+approval\b/i),
  },
];

const FRONTEND_UI_RULES: { id: string; holds: (text: string) => boolean }[] = [
  {
    id: 'panel-wrap-and-whole-button-group',
    holds: text =>
      /\b(?:panels?|rows?|cards?)\b[\s\S]*\bfull text\b[\s\S]*\bactions\b/i.test(text) &&
      /\blong words\b[\s\S]*\bURLs?\b[\s\S]*\bwrap\b/i.test(text) &&
      /\b(?:whole group|together as one group)\b[\s\S]*\b(?:one|single) even row\b/i.test(text) &&
      /\b(?:same|shared|consistent) edge\b[\s\S]*\bspacing\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\b(?:hide|clip|truncate|ellipsis)\b/i.test(text) &&
      forbids(text, /\b(?:truncate|clip)\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:text|words|buttons|actions|overflow|ellipsis)\b/i) &&
      forbids(text, /\bhide\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:text|action|buttons?|controls?|group|overflow)\b/i) &&
      forbids(text, /\bwrap\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bbuttons?\s+one by one\b/i),
  },
  {
    id: 'parallel-nonvisual-visual-only-waits',
    holds: text =>
      /\bnon-visual\b[\s\S]*\bdata\b[\s\S]*\bAPI\b[\s\S]*\blogic\b[\s\S]*\bstates\b[\s\S]*\bskeleton\b[\s\S]*\bin parallel\b/i.test(text) &&
      /\bonly\b[^.!?]*\bvisual\b[^.!?]*\bwaits?\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\binvent\b[^.!?]*\b(?:tokens?|spacing)\b/i.test(text) &&
      forbids(text, /\bwait\w*\b(?:(?!\b(?:without|instead of|only)\b)[^.!?;,])*\bdesign mockup\b[^.!?;,]*\bbefore\b[^.!?;,]*\b(?:API|state|logic|skeleton)\b/i) &&
      forbids(text, /\binvent\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:tokens?|spacing)\b/i),
  },
  {
    id: 'multilang-and-dynamic-shipped-locales',
    holds: text =>
      /\b20\s*(?:to|-)\s*30\s+languages\b/i.test(text) &&
      /\b1\.5x?\b[\s\S]*\b2x?\b/i.test(text) &&
      /\bCJK\b[\s\S]*\bDevanagari\b[\s\S]*\bline-height\b/i.test(text) &&
      /\bRTL\b[\s\S]*\bmirror\w*\b/i.test(text) &&
      /\blongest\b[\s\S]*\bshortest\b[\s\S]*\b(?:actually )?(?:shipped|supported)\b[\s\S]*\breal\b/i.test(text) &&
      /\bRTL\b[^.!?]*\b(?:when|once)\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\bpseudo-locale\b/i.test(text) &&
      forbids(text, /\bcount\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:pseudo-locale|demo string)\b[^.!?;,]*\bas a (?:real |shipped |supported )?language\b/i) &&
      forbids(text, /\b(?:always )?check\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bfixed two-language pair\b/i),
  },
  {
    id: 'project-reference-without-company-lockin',
    holds: text =>
      /\brepository\b[\s\S]*\b(?:style book|design reference|UI reference)\b/i.test(text) &&
      !/hornhoof|\.notebook|\.side-panel|theme\.css|\b(?:Russian|English)\b/i.test(text),
  },
  {
    id: 'explicit-component-geometry-and-scrollbar-space',
    holds: text =>
      /\breset\b[\s\S]*\bexplicit\b[\s\S]*\bbrowser default\b/i.test(text) &&
      /\bscrollbar space\b[\s\S]*\bscrollable panels?\b[\s\S]*\boverlay\b/i.test(text) &&
      /\b(?:never|do not|instead of)\b[^.!?]*\bbrowser default\b/i.test(text) &&
      forbids(text, /\brely\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bbrowser default\b/i) &&
      forbids(text, /\bassum\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\boverlay scrollbars?\b/i),
  },
  {
    id: 'three-browser-engines-check',
    holds: text =>
      /\bChromium\b[\s\S]*\bFirefox\b[\s\S]*\bWebKit\b/.test(text) &&
      /\b(?:never|do not|instead of)\b[^.!?]*\b(?:single|one) browser engine\b/i.test(text) &&
      forbids(text, /\b(?:claim|count)\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:single|one) browser engine\b[^.!?;,]*\bas\b[^.!?;,]*\bcross-engine\b/i),
  },
];

type ReconciledCheckSkills = {
  tdd: string;
  policy: string;
  language: string;
  implement: string;
  browser: string;
  e2e: string;
  ciRelease: string;
};

const INCIDENT_ATTRIBUTION_RE = /\b(?:Added|Patch|Remember|Never give)\b[^.!?\n]*\b(?:by|from|for|give)\s+[A-Z][A-Za-z]+/;
const INCIDENT_OR_BRAND_LEAK_RE = /\b(?:hornhoof|github|claude|codex|kimi|antigravity)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\bv?\d+\.\d+\.\d+\b|@\S+\.\S+|\/(?:Users|home)\/\w+/i;
const hasIncidentOrBrandLeak = (text: string): boolean => INCIDENT_OR_BRAND_LEAK_RE.test(text) || INCIDENT_ATTRIBUTION_RE.test(text);

const matchesAll = (text: string, patterns: RegExp[]): boolean => patterns.every(re => re.test(text));

const forbidsAll = (text: string, patterns: RegExp[]): boolean => patterns.every(re => forbids(text, re));

const RUN_CHECKS_CORE_RULES: { id: string; holds: (text: string) => boolean }[] = [
  { id: 'named-test-files-local-red-green', holds: text => matchesAll(text, [/affected tests in your workspace/i, /name the executed test files/i]) && forbids(text, /\brun\w*\b[^.!?;,]*\ba directory\s+locally\b/i) },
  { id: 'local-lockfile-installs', holds: text => /prepare the workspace through the project's declared setup/i.test(text) && !/Never install dependencies locally/i.test(text) },
  { id: 'noncheck-run-work-separate-from-mixed-checks', holds: text => /preparation command proves no test passed/i.test(text) && forbids(text, /\bcount\w*\b[^.!?;,]*\brun_work\b[^.!?;,]*\bas\s+T2\b/i) },
  { id: 'unavailable-route-blocks-and-refusal-never-pass', holds: text => /record the unproved scope and why/i.test(text) && forbidsAll(text, [/\bfall back to running the whole suite locally/i, /\btreat\w*\b[^.!?;,]*\brefusal as PASS/i]) },
  { id: 'abstract-english-no-incident-facts', holds: text => !hasIncidentOrBrandLeak(text) },
];

const RECONCILED_SKILL_SOURCE_RULES: { id: string; holds: (s: ReconciledCheckSkills) => boolean }[] = [
  { id: 'no-skill-names-hh-run-checks', holds: s => forEvery(Object.values(s), text => !/\bhh-run-checks\b/.test(text)) },
  { id: 'local-change-checks-and-remote-release-suite', holds: s => !/Run the whole suite locally|Send author checks through run_tests/i.test(Object.values(s).join('\n')) && /relies on the repository's own CI for that exact commit/i.test(s.ciRelease) && /exact candidate[\s\S]*assigned checks/i.test(s.ciRelease) },
  { id: 'browser-suite-remote-light-screenshot-distinct', holds: s => matchesAll(s.browser, [/lightweight screenshot capture/i, /browser binary name alone/i]) && forbids(s.browser, /\btreat\w*\b[^.!?;,]*\bscreenshot capture as a full browser test suite/i) },
];

const HEAD_OUTAGE_AND_AUTHORITY_RULES: { id: string; holds: (text: string) => boolean }[] = [
  {
    id: 'outage-does-not-prolong-hold-and-lifts-at-once',
    holds: text =>
      matchesAll(text, [
        /\bexternal service failure\b[^.!?]*\bnever prolongs a general hold once the service recovers\b/i,
        /\b(?:hold is lifted|lifted hold)\b[^.!?]*\bat once(?: in one pass)? to every affected holder\b/i,
      ]) && forbids(text, /\bkeep\w*\s+a\s+general\s+hold\s+active\s+after\s+the\s+external\s+service\s+recovers\b/i),
  },
  {
    id: 'local-error-isolated-and-orchestrator-decisions-forwarded',
    holds: text =>
      matchesAll(text, [
        /\brepeated local error\b[\s\S]*\bnever freezes unrelated work\b/i,
        /\borchestrator's authority promptly\b[^.!?]*\binstead of holding them in your own queue\b/i,
      ]) && forbidsAll(text, [/\bfreeze\w*\s+all\s+unrelated\s+tasks\b/i, /\bhold\w*\s+orchestrator-level\s+decisions\s+in\s+your\s+own\s+queue\b/i]),
  },
  {
    id: 'abstract-head-rule-preserves-gates-and-dependencies',
    holds: text => {
      const section = text.slice(text.indexOf('External outages and holds:'));
      return (
        matchesAll(section, [/^External outages and holds:/i, /\bdependencies\b[\s\S]*\bprotected actions\b[\s\S]*\baccess boundaries\b[\s\S]*\brelease gates\b/i]) &&
        !hasIncidentOrBrandLeak(section)
      );
    },
  },
];

const UNSHIPPED_EXTERNAL_AUTOMATION_RE = /\b(?:automatically retries|intercepts git push|blocks task creation|waits for GitHub)\b/i;

type HeadLoadSkills = { lead: string; breakDown: string };

const HEAD_LOAD_LEAK_RE = /\b(?:github|claude|codex|kimi|antigravity)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\b|@\S+\.\S+|\/(?:Users|home)\/\w+/i;
const UNSHIPPED_IDLE_WAKE_RE = /\bhornhoof\s+(?:automatically\s+)?wakes\s+you[^.!?]*\b(?:free|idle)\b/i;

const HEAD_DEPARTMENT_LOAD_RULES: { id: string; holds: (s: HeadLoadSkills) => boolean }[] = [
  {
    id: 'free-members-with-runnable-work-is-fault-and-head-owns-load',
    holds: s =>
      /\bconnected block one owner\b/i.test(s.breakDown) &&
      forEvery([s.lead], text =>
        matchesAll(text, [
          /\bwhoever gives out the work answers for keeping the department loaded,\s*not only for ordering tasks\b/i,
          /\bmembers standing free while\b[^.!?]*\bare a fault,\s*not a normal wait\b/i,
        ]),
      ) &&
      forbidsAll(`${s.lead}\n${s.breakDown}`, [
        /\bstanding free\b[^.!?;,]*\bis a normal wait\b/i,
        /\bonly orders tasks\b/i,
      ]),
  },
  {
    id: 'after-chains-require-independent-part-or-none-preserving-boundaries',
    holds: s =>
      forEvery([s.lead], text =>
        matchesAll(text, [
          /`independentPart`/,
          /`independentNone`/,
          /\bgenuine dependency\b[\s\S]*\bsame-file ownership\b[\s\S]*\brelease boundary\b/i,
          /\bpass neither when `after` is empty\b/i,
        ]),
      ) &&
      matchesAll(s.lead, [
        /\bparent waits\b/i,
        /\bCarve out a genuinely independent part while another result is pending\b/,
      ]) &&
      forbidsAll(`${s.lead}\n${s.breakDown}`, [
        /\bleave\w*\s+after\s+tasks\s+without\s+independentPart\s+or\s+independentNone\b/i,
        /\bsend\w*\s+independentNone\s+tasks\s+out\s+early\b/i,
      ]),
  },
  {
    id: 'urgent-only-team-refuses-non-urgent-and-names-free-peers',
    holds: s =>
      matchesAll(s.lead, [
        /\bNever assign ordinary or non-urgent work to members of an urgent-only team\s*\(`urgentOnly`\)/,
        /\brefuses the assignment and names free members in the same role\b/i,
      ]) &&
      forbids(`${s.lead}\n${s.breakDown}`, /\bassign\w*\s+(?:ordinary\s+(?:or\s+)?)?non-urgent\s+work\s+to\s+(?:members\s+of\s+)?an\s+urgent(?:-only|Only)\s+team\b/i),
  },
  {
    id: 'abstract-no-incident-names-or-unshipped-idle-wake',
    holds: s => {
      const joined = `${s.lead}\n${s.breakDown}`;
      return !HEAD_LOAD_LEAK_RE.test(joined) && !INCIDENT_ATTRIBUTION_RE.test(joined) && !UNSHIPPED_IDLE_WAKE_RE.test(joined) && s.lead.split('External outages and holds:').length - 1 === 1;
    },
  },
];

/* The orchestrator leads by the skill every head leads by, which holds the one rule for holds, and his own skill for trouble
   adds what only he decides. */
type OrchestratorOutageSkills = { lead: string; trouble: string };

const ORCHESTRATOR_OUTAGE_RULES: { id: string; holds: (s: OrchestratorOutageSkills) => boolean }[] = [
  {
    id: 'outage-not-grounds-for-longer-general-hold',
    holds: ({ lead, trouble }) =>
      matchesAll(lead, [/\bexternal service failure\b[^.!?]*\bnever prolongs a general hold once the service recovers\b/i]) &&
      matchesAll(trouble, [/\bexternal service failure does not keep a general hold after recovery\b/i]) &&
      forbids(`${lead}\n${trouble}`, /\bkeep\w*\s+a\s+general\s+hold\s+active\s+after\s+the\s+external\s+service\s+recovers\b/i),
  },
  {
    id: 'orchestrator-decides-and-communicates-in-one-action',
    holds: ({ trouble: text }) =>
      matchesAll(text, [
        /\bdecide\b[\s\S]*\bhold\b[\s\S]*\bone action to every affected holder\b/i,
        /\b(?:never|not)\b[^.!?]*\b(?:department )?head's (?:serial )?queue\b/i,
      ]) && forbids(text, /\bsend\w*[^.!?;,]*\bthrough a department head's queue\b/i),
  },
  {
    id: 'ordinary-retry-needs-no-permission-or-diagnosis-chain',
    holds: ({ trouble: text }) =>
      matchesAll(text, [
        /new checks stop advancing the diagnosis/i,
        /\bordinary safe retry of a transient external failure needs no extra permission\b/i,
        /\bordinary safe retry of a transient external failure needs no extra permission\b/i,
      ]) &&
      forbidsAll(text, [
        /\brequire\w*\s+permission\s+before\s+any\s+ordinary\s+retry\b/i,
        /\bone attempt\b/i,
        /\bno retries\b/i,
        /\bdeclare recovery\b/i,
      ]),
  },
  {
    id: 'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
    holds: ({ trouble: text }) => {
      const section = text;
      return (
        matchesAll(section, [
          /\bforce pushes\b[\s\S]*\balternate refs\b[\s\S]*\bpermission changes\b[\s\S]*\birreversible actions\b[\s\S]*\bdangerous or non-idempotent (?:actions|retries)\b/i,
        ]) &&
        !hasIncidentOrBrandLeak(section) &&
        !/\b\d{1,2}\.\d{1,2}\b/.test(section) &&
        !UNSHIPPED_EXTERNAL_AUTOMATION_RE.test(text)
      );
    },
  },
];

const forEvery = <Item>(items: Item[], predicate: (item: Item) => boolean): boolean => items.every(predicate);

const failedRuleIds = <Input>(rules: { id: string; holds: (input: Input) => boolean }[], input: Input): string[] =>
  rules.filter(rule => !rule.holds(input)).map(rule => rule.id);

type MechanicalSkills = { diff: string; verdict: string };

const documentedCategories = (text: string): string[] => {
  const clause = /category(?:\s*:\s*[^,)]+|\s*\([^)]+\))/.exec(text)![0];
  return [...clause.matchAll(/['`]([a-z_]+)['`]/g)].map(m => m[1]!);
};

const MECHANICAL_CATEGORY_RULES: { id: string; holds: (s: MechanicalSkills) => boolean }[] = [
  {
    id: 'strict-behavior-unchanged-boundary',
    holds: s =>
      forEvery([s.verdict], text =>
        matchesAll(text, [
          /\bprovably cannot change\b[^.!?]*\bbehaviour\b/i,
          /\bformatting\b[\s\S]*\blint\b[\s\S]*\bsafe local rename\b[\s\S]*\bmissing translation key\b/i,
          /\bpublic API\b[\s\S]*\bsemantics\b/i,
        ]),
      ) &&
      forbidsAll(`${s.diff}\n${s.verdict}`, [
        /\bclassify\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:public API rename|semantic change)\b[^.!?;,]*\bas\s+['`]?mechanical['`]?/i,
        /\buse\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b['`]?mechanical['`]?\b[^.!?;,]*\bwhen\s+a\s+fix\s+may\s+change\s+behaviour\b/i,
      ]),
  },
  {
    id: 'doubt-keeps-regular-category-and-full-base-level',
    holds: s =>
      forEvery([s.verdict], text =>
        matchesAll(text, [
          /\bwhen in doubt\b[^.!?]*\bregular category\b[\s\S]*\bfull base level\b/i,
          /\b(?:never|do not)\s+classify\b[^.!?]*\bsecurity\b[\s\S]*\bdata\b[\s\S]*\bspec\b[\s\S]*\bmechanical\b[^.!?]*\bmedium\b/i,
        ]),
      ) &&
      sentencesOf(`${s.diff}\n${s.verdict}`).every(sentence =>
        negatesBefore(sentence, /\bwhen in doubt,\s*(?:mark|classify|use)\w*\b[^.!?]*\b['`]?mechanical['`]?/i),
      ) &&
      forbidsAll(`${s.diff}\n${s.verdict}`, [
        /\bclassify\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:security|data|spec)\b[^.!?;,]*\bas\s+['`]?mechanical['`]?\s+to\s+run\s+at\s+medium\b/i,
      ]),
  },
  {
    id: 'same-owner-repair-without-effort-or-return',
    holds: s => /does not set effort or change effort inside a running turn/.test(s.verdict) &&
      /never opens another review or sends a mechanical fix back to the author/.test(s.verdict) &&
      sentencesOf(`${s.diff}\n${s.verdict}`).every(sentence => [
        /\bswitch\w*\b[^.!?;,]*\beffort\s+inside\s+a\s+running\s+turn\b/i,
        /\bopen\w*\b[^.!?;,]*\bsecond\s+review\s+for\s+['`]?mechanical['`]?\s+findings\b/i,
        /\bset\w*\s+Wake\.mechanical\s+on\s+mixed\s+verdicts\b/i,
      ].every(rule => negatesBefore(sentence, rule))),
  },
  {
    id: 'abstract-english-no-incident-or-company-leaks',
    holds: s => {
      const joined = `${s.diff}\n${s.verdict}`;
      return !/\b(?:hornhoof|github|Russian|English)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\bv?\d+\.\d+\.\d+\b|@\S+\.\S+|\/(?:Users|home)\/\w+|[\u2014\u0451\u0401]/i.test(joined) && !INCIDENT_ATTRIBUTION_RE.test(joined);
    },
  },
];

/* The tokens a built-in skin of the web app sets. The book's two colour columns are the Light skin and Cyberpunk, the dark one. */
const skinTokens = async (root: string, id: string): Promise<Record<string, string>> => {
  const registry = (await import(pathToFileURL(join(root, 'apps/web/src/skins/registry.ts')).href)) as { builtinSkin: (id: string) => unknown };
  const roles = (await import(pathToFileURL(join(root, 'apps/web/src/skins/roles.ts')).href)) as { declarations: (look: unknown) => [string, string][] };
  return Object.fromEntries(roles.declarations(registry.builtinSkin(id)));
};

/* A font stack as its families in order: a family name is the same with quotes or without. */
const fontFamilies = (stack: string | undefined) => stack?.split(',').map(font => font.trim().replace(/^'(.*)'$/, '$1'));

const styleBookSources = (book: string): string[] => [
  ...[...book.matchAll(/`((?:ui|screens)\/[\w./-]+\.tsx?)`/g)].map(m => `apps/web/src/${m[1]!}`),
  ...[...book.matchAll(/`((?:apps|templates|guide|\.github)\/[\w./-]+\.\w+)`/g)].map(m => m[1]!),
  ...[...book.matchAll(/`([A-Z_]+\.md)`/g)].map(m => m[1]!),
];

describe('only an irreversible deletion needs the CEO, and what goes out needs nobody', () => {
  it('lets department heads and the orchestrator act on ordinary work', () => {
    const lead = templates.skills.get('hh-lead-tasks')!.body;
    expect(ORCHESTRATOR_SKILLS).toContain('hh-lead-tasks');
    expect(HEAD_SKILLS).toContain('hh-lead-tasks');
    expect(lead).toMatch(/resolve ordinary work directly instead of asking for confirmation/i);
    expect(lead).toMatch(/ask the CEO for a recorded yes only for irreversible deletion/i);
    expect(lead).toMatch(/sending, posting and talking to people are the department's work[\s\S]*honor opt-outs[\s\S]*installed phone app at a human pace/i);
  });

  it('uses the human question only for a person-specific action or choice', () => {
    expect(CORE_SKILLS).toEqual(expect.arrayContaining(['hh-questions', 'hh-stay-in-scope']));
    const questions = templates.skills.get('hh-questions')!.body;
    expect(questions).toMatch(/only that person can supply[\s\S]*recorded yes only for irreversible deletion/i);
    expect(questions).toMatch(/ask its holder to add the sign-in to the vault/i);
  });

  it('lets no skill ask for an account sign-up that costs nothing', () => {
    expect(templates.skills.get('ops-intake')!.body).toMatch(/Paid plans wait for a person to pay[^.!?]*own account/);
    expect(templates.skills.get('ops-intake')!.body).toMatch(/free account[^.!?]*signs up[^.!?]*itself/i);
    const signup = templates.skills.get('ops-account-signup')!;
    expect(signup.body).toMatch(/A free account needs nobody's yes/);
    expect(signup.body).toMatch(/paid plan waits for a person to pay from their own account/);
    expect(`${signup.description.en} ${signup.body}`).not.toMatch(/\bCEO's approval\b|approval and help/);
    expect(signup.body).toMatch(/the person responsible for payment enters payment details/i);
  });
});

/* Hornhoof sends nothing for a company: an agent writes and publishes like a person and keeps every record of it in its
   department's git, in whatever format suits the work. */
describe('writing to people outside', () => {
  it('shares outbound delivery, opt-out and channel rules across departments', () => {
    const shared = templates.skills.get('hh-outside-is-data')!.body;
    expect(shared).toMatch(/assigned company account[\s\S]*verify the recipient[\s\S]*department's repository[\s\S]*honor opt-outs/i);
    expect(shared).toMatch(/installed phone app[\s\S]*one action at a time[\s\S]*at a human pace/i);
    expect(shared).toMatch(/apply only an approval rule the department set/i);
    expect(templates.skills.get('sal-outbound-approval')!.body).toMatch(/authorized terms[\s\S]*a person signs contracts/i);
    expect(templates.skills.get('mkt-publish-approval')!.body).toMatch(/verify the actual text, media and links[\s\S]*permanent deletion needs the CEO's recorded yes/i);
  });

  /* The roles that write letters to people outside: each sends and reads its department's mail from its own machine. */
  const MAIL_WRITERS = ['SAL-HEAD', 'SAL-SDR', 'SAL-AE', 'MKT-HEAD', 'MKT-SOCIAL', 'SUP-HEAD', 'SUP-T1', 'SUP-T2', 'BIZ-HEAD', 'BIZ-PARTNER', 'OPS-HEAD', 'OPS-ACCT'];
  const mail = () => templates.skills.get('hh-mail')!;

  it('uses the assigned mailbox for threads, attachments and verified delivery', () => {
    expect(mail().kind).toBe('procedure');
    const text = [mail().body, mail().title.en, mail().title.ru, mail().description.en, mail().description.ru].join('\n');
    expect(text).not.toMatch(INCIDENT_OR_BRAND_LEAK_RE);
    expect(text).not.toMatch(INCIDENT_ATTRIBUTION_RE);
    expect(mail().body).toMatch(/assigned company mailbox[\s\S]*thread[\s\S]*recipients, contents and attachments/i);
    expect(mail().body).toMatch(/verify delivery[\s\S]*sent folder and receipt before retrying/i);
  });

  it('enters mailbox credentials in the protected sign-in field', () => {
    expect(mail().body).toMatch(/vault[\s\S]*sign in yourself at the protected sign-in field[\s\S]*only the vault entry name/i);
    expect(mail().body).not.toMatch(/environment variable|MAIL_PASSWORD|standard input/i);
  });

  it('locks the mail ability on for every role that writes to people, so each one hired before has it too', () => {
    for (const id of MAIL_WRITERS) expect(templates.roles.get(id)!.skills.find(s => s.id === 'hh-mail'), id).toEqual({ id: 'hh-mail', on: true, locked: true });
    const carriers = roles.filter(role => role.skills.some(s => s.id === 'hh-mail')).map(role => role.id);
    expect(carriers.sort()).toEqual([...MAIL_WRITERS].sort());
  });

  it('lets mailbox work use the assigned client without a cross-skill reference', () => {
    for (const id of ['sal-outbound-approval', 'mkt-publish-approval', 'sup-support-policy']) {
      expect(templates.skills.get(id)!.body, id).not.toContain(mail().title.en);
    }
    expect(mail().body).toMatch(/assigned company mailbox[\s\S]*supported secure client/i);
  });

  it("keeps support's own safeguards in each support role's abilities", () => {
    expect(templates.roles.get('SUP-T2')?.effort).toBe('high');
    for (const id of ['SUP-HEAD', 'SUP-KB', 'SUP-T1', 'SUP-T2'] as const) {
      const role = templates.roles.get(id)!;
      expect(role.body, id).toMatch(/^You are [^\n.!?]+\.$/);
      const rendered = renderInstructions(templates, { id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: 'Ari', roleKey: id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Support', product: null });
      const abilities = [rendered.text, ...rendered.skills.map(file => file.body)].join('\n');
      expect(abilities, id).toMatch(/department's (?:git|repository)/);
      if (id !== 'SUP-KB') {
        expect(abilities, id).toMatch(/vault/);
        expect(abilities, id).toMatch(/department(?:'s)? owner[\s\S]*CEO/);
        expect(abilities, id).toMatch(/\b(?:never|do not)\b[^.!?]*\b(?:refunds?|prices?|legal|contract|delivery[- ]dates?)\b/i);
      }
      expect(abilities, id).toMatch(/untrusted data/);
      expect(abilities, id).toMatch(/secret|personal data/);
    }
  });
});

type ImpactSelectionSkills = { implement: string; policy: string; agents: string };

const IMPACT_SELECTION_RULES: { id: string; holds: (s: ImpactSelectionSkills) => boolean }[] = [
  {
    id: 'author-dependent-tests-in-workspace-and-new-tests-always',
    holds: s =>
      forEvery([s.implement, s.policy], text => /\b(?:dependent|selected|affected)\s+(?:tests?|checks?)\b/i.test(text)) &&
      matchesAll(s.implement, [/\bexplicit selector\b/i]) &&
      matchesAll(s.policy, [
        /\bnew(?:ly\s+added)?\s+test\b[\s\S]*\balways\b|\balways\b[\s\S]*\bnew(?:ly\s+added)?\s+test\b/i,
        /\binput paths\b[\s\S]*\bselected inventory\b[\s\S]*\bfallback reason\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\bskip\w*\s+new(?:ly\s+added)?\s+tests?\s+when\s+no\s+graph\s+edge\s+reaches\s+them\b/i,
      ]),
  },
  {
    id: 'outside-graph-uncertain-whole-package-and-migrations-up-down',
    holds: s =>
      matchesAll(s.policy, [
        /\bmigrations\b[\s\S]*\bschema\b[\s\S]*\bconfiguration\b[\s\S]*\benvironment\b[\s\S]*\broutes\b[\s\S]*\bfixtures\b[\s\S]*\bstring tables\b[\s\S]*\bscripts\b[\s\S]*\binstallation\b[\s\S]*\bupdates\b[\s\S]*\bshared packages\b[\s\S]*\bAPI contracts\b[\s\S]*\btemplates\b/i,
        /\bout-of-graph policy\b/i,
        /\bcomplete\s+affected\s+packages?\b/i,
        /\bup(?: and |\/)down\b/i,
        /\breport\b[^.!?]*\bunsupported\b|\bunsupported\b[^.!?]*\breport\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\btreat\w*\s+an\s+unavailable\s+adapter\s+as\s+an\s+empty\s+selection\b/i,
        /\brun\w*\s+migrations?\s+up\s+only\s+without\s+reporting\b/i,
      ]),
  },
  {
    id: 'explicit-selector-commands-no-auto-promise-and-execution-distinct',
    holds: s =>
      matchesAll(s.agents, [
        /scripts\/test\/impact-README\.md/,
        /scripts\/test\/related-probe\.mjs/,
        /scripts\/test\/impact-python\/pytest_impact\.py/,
        /scripts\/test\/replay-impact\.mjs/,
        /\bNOT_RUN\b/,
      ]) &&
      matchesAll(s.policy, [
        /\bNOT_RUN\b/,
        /\bCollection is not execution\b[\s\S]*\bcompleted exact-version receipts\b/i,
        /\bunavailable rather than zero\b[^.!?]*\bcomparator\b/i,
        /\bone owner coordinates\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\brun_tests\s+automatically\s+selects\s+impact\s+tests\s+from\s+the\s+test\s+environment\b/i,
        /\btreat\w*\s+a\s+collected\s+graph\s+as\s+completed\s+test\s+execution\b/i,
        /\btreat\w*\s+missing\s+comparator\s+evidence\s+as\s+zero\s+misses\b/i,
      ]),
  },
  {
    id: 'abstract-english-no-dates-names-or-numbers',
    holds: s => {
      const t2 = s.policy.split('\n').find(line => line.startsWith('- **T2:')) ?? '';
      const joined = `${s.implement}\n${t2}`;
      return !/\b(?:Russian|English)\b|\bturn\s+\d+\b|#\d+|\b202\d-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\b|\bv?\d+\.\d+\.\d+\b|@\S+\.\S+|\/(?:Users|home)\/\w+|scripts\/test|[\u2014\u0451\u0401]/i.test(joined) && !INCIDENT_ATTRIBUTION_RE.test(joined);
    },
  },
];

describe('T2 impact-selection rules across dev-implement, dev-testing-policy and the project rules', () => {
  const impactSkills = (): ImpactSelectionSkills => ({
    implement: templates.skills.get('dev-implement')!.body,
    policy: templates.skills.get('dev-testing-policy')!.body,
    agents: readFileSync(join(DIR, '../AGENTS.md'), 'utf8'),
  });

  it('teaches explicit impact selection, whole-package fallbacks, bidirectional migrations, execution vs collection evidence, and explicit scripts/test commands without promising unshipped runner wiring', () => {
    expect(failedRuleIds(IMPACT_SELECTION_RULES, impactSkills())).toEqual([]);
  });

  it('rejects skill text that promises unshipped automatic runner selection, conflates graph collection with execution, skips new tests, or leaks dates, names or task numbers', () => {
    const base = impactSkills();
    expect(failedRuleIds(IMPACT_SELECTION_RULES, base)).toEqual([]);
    const cases: [keyof ImpactSelectionSkills, string, string][] = [
      ['implement', 'Skip newly added tests when no graph edge reaches them.', 'author-dependent-tests-in-workspace-and-new-tests-always'],
      ['policy', 'Treat an unavailable adapter as an empty selection and run migrations up only without reporting.', 'outside-graph-uncertain-whole-package-and-migrations-up-down'],
      ['policy', 'Today run_tests automatically selects impact tests from the test environment.', 'explicit-selector-commands-no-auto-promise-and-execution-distinct'],
      ['policy', 'Treat a collected graph as completed test execution and treat missing comparator evidence as zero misses.', 'explicit-selector-commands-no-auto-promise-and-execution-distinct'],
      ['implement', 'Added by SampleMember on 2026-01-15 for #42 against turn 3.', 'abstract-english-no-dates-names-or-numbers'],
    ];
    for (const [target, extra, expectedRule] of cases) {
      expect(failedRuleIds(IMPACT_SELECTION_RULES, { ...base, [target]: `${base[target]}\n${extra}` }), extra).toContain(expectedRule);
    }
  });
});

describe('skills compose around an assignment without a universal role', () => {
  const body = (id: string) => templates.skills.get(id)!.body;
  const render = (roleKey: string, selected: string[]) => renderInstructions(templates, { id: 'a', companyId: 'c', kind: 'worker', name: 'Ari', roleKey, skills: selected, overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });

  it.each(['dev-review-diff', 'dev-security-review'])('%s supports self-inspection but never replaces an independent gate', id => {
    expect(body(id)).toMatch(/same for your own change and for someone else's/);
    expect(body(id)).toMatch(/On your own change, read the diff cold/);
    expect(body(id)).toMatch(/own review replaces no gate/);
    expect(body(id)).toMatch(/independent gate[\s\S]*never approve/i);
    expect(body(id)).not.toContain('dev-review-verdict');
  });

  it('keeps mandatory Review and its repairs with the current checking owner', () => {
    const verdict = body('dev-review-verdict');
    expect(templates.skills.get('dev-review-verdict')!.kind).toBe('gate');
    expect(verdict).toMatch(/read the actual task route, version, criteria and repair ownership/i);
    expect(verdict).toMatch(/failed verdict keeps ownership with you[\s\S]*fix it within the assigned paths/);
    expect(verdict).not.toContain('task.fixReview');
    expect(verdict).toMatch(/review is required for executable results on the Development route/i);
    for (const id of ['DEV-REV', 'DEV-SEC']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-review-verdict')?.on).toBe(true);
  });

  it('delivers a broad chosen skill set to an ordinary worker without inventing a generalist role', () => {
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    for (const role of roles) expect(role.title.en).not.toMatch(/generalist|universal/i);
    const selected = ['dev-implement', 'dev-review-diff', 'dev-security-review', 'dev-ci-release', 'fin-independent-recompute', 'sal-account-research'];
    for (const roleKey of ['DEV-ENG', 'SUP-T2']) {
      const rendered = render(roleKey, selected);
      for (const id of selected) expect(rendered.skills.find(file => file.name === id)?.body, `${roleKey} ${id}`).toContain(body(id));
      expect(rendered.parts.find(part => part.kind === 'base')?.text).toBe(templates.roles.get(roleKey)!.body);
    }
  });

  it.each(skills.filter(skill => skill.kind !== 'core'))('delivers $id without its default role or other optional abilities', skill => {
    const rendered = render('DEV-ENG', [skill.id]);
    /* Besides the files every employee carries, as a procedure of everyone's is read when it is needed. */
    const everyones = CORE_SKILLS.filter(id => templates.skills.get(id)!.kind !== 'core');
    expect(rendered.skills.map(file => file.name)).toEqual([...new Set([...everyones, skill.id])]);
    expect(rendered.skills.find(file => file.name === skill.id)!.body).toContain(skill.body);
    expect(rendered.text).not.toContain('when that one is not on your list, go on without it');
  });

  it('requires browsers only for web surfaces and preserves non-web product checks', () => {
    const check = body('dev-browser-check');
    for (const surface of ['command-line tool', 'public API', "library's public interface"]) expect(check).toContain(surface);
    expect(check).toContain('A change nothing reaches that way has no run to do here: its tests are the check');
    expect(body('dev-qa-acceptance')).toContain('a browser only for a web page');
    expect(body('dev-testing-policy')).toMatch(/browser engines where relevant/);
  });

  it('preserves language-specific abilities as optional selections', () => {
    for (const role of roles) for (const id of ['mkt-russian-copy', 'mkt-telegram-vk', 'mkt-yandex-seo']) expect(role.skills.find(s => s.id === id)?.on ?? false, `${role.id} ${id}`).toBe(false);
    expect(body('dev-language-rules')).toMatch(/report a missing or unsupported capability by purpose/i);
    expect(body('dev-testing-policy')).toMatch(/unsupported or unavailable measures marked NOT_RUN/);
  });

  it('keeps speed subordinate to actual checks and exact-version evidence', () => {
    for (const role of roles) expect(role.skills.find(s => s.id === 'hh-work-fast')?.on, role.id).toBe(true);
    const fast = body('hh-work-fast');
    expect(fast).toMatch(/check and the approval win/);
    expect(fast).toMatch(/exact commit or version/);
    expect(fast).toMatch(/skill you follow and the output of a check are read whole/i);
  });

  it('keeps private incident facts out of generic role and skill templates', () => {
    const leak = /(?:^|\s)#\d{2,}\b|\b202\d-\d{2}-\d{2}\b|\bturn\s+\d+\b|\bv\d+\.\d+\.\d+\b|@\S+\.\S+|\/(?:Users|home)\/\w+/i;
    for (const item of [...roles, ...skills]) {
      expect(item.body, item.id).not.toMatch(leak);
      expect(item.body, item.id).not.toMatch(INCIDENT_ATTRIBUTION_RE);
    }
  });
});

describe('identity, defaults and shared instruction delivery', () => {
  const render = (role: (typeof roles)[number], selected: string[], who = { name: 'Ari', company: 'Acme', department: 'Work' }) =>
    renderInstructions(
      templates,
      { id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: who.name, roleKey: role.id, skills: selected, overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1],
      { company: who.company, department: who.department, product: null },
    );

  it('delivers every locked ability once even when optional selections are empty', () => {
    for (const role of roles) {
      const rendered = render(role, []);
      const required = [...CORE_SKILLS, ...(role.kind === 'head' ? HEAD_SKILLS : MEMBER_SKILLS), ...role.skills.filter(skill => skill.locked).map(skill => skill.id)];
      for (const id of required) expect(rendered.parts.filter(part => part.kind === 'skill' && part.id === id), `${role.id} ${id}`).toHaveLength(1);
      expect(rendered.parts.find(part => part.kind === 'base')?.text, role.id).toBe(role.body);
    }
  });

  it('preserves default role selections without treating their prefixes as permission boundaries', () => {
    for (const role of roles) {
      const selected = role.skills.filter(skill => skill.on).map(skill => skill.id);
      const rendered = render(role, selected);
      for (const id of selected) expect(rendered.parts.some(part => part.kind === 'skill' && part.id === id), `${role.id} ${id}`).toBe(true);
    }
    expect(ORCHESTRATOR_SKILLS).toEqual(expect.arrayContaining(['orch-company', 'orch-pipelines', 'orch-staff', 'orch-people', 'orch-resources']));
  });

  it('keeps the orchestrator identity to one sentence and its workflow in selected abilities', () => {
    expect(ORCHESTRATOR_INSTRUCTIONS).toMatch(/^You are [^\n.!?]+\.$/);
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/hh-lead-tasks|plan_turn|build_structure/);
    const steady = orchestratorSteady(templates);
    expect(steady.parts.map(part => part.kind)).toEqual(['base', 'assignment', ...ORCHESTRATOR_SKILLS.map(() => 'skill')]);
    expect(steady.parts[0]!.text).toBe(ORCHESTRATOR_INSTRUCTIONS);
    for (const id of ORCHESTRATOR_SKILLS) expect(steady.parts.filter(part => part.id === id)).toHaveLength(1);
  });

  it('tells every employee and the orchestrator, in a file read when it is needed, when one-shot calls fit and when not', () => {
    expect(CORE_SKILLS).toContain('hh-one-shot-calls');
    expect(ORCHESTRATOR_SKILLS).toContain('hh-one-shot-calls');
    const skill = templates.skills.get('hh-one-shot-calls')!;
    expect(skill.kind).toBe('procedure');
    expect(skill.body).toMatch(/start_calls[\s\S]*calls[\s\S]*stop_calls/);
    expect(skill.body).toMatch(/Use calls when:[\s\S]*independent[\s\S]*judge[\s\S]*one-shot/);
    expect(skill.body).toMatch(/Do it yourself[^:]*when:[\s\S]*questions[\s\S]*browser[\s\S]*depends on the answer/);
    expect(skill.body).toMatch(/assigned plan supports calls[\s\S]*retrieve the full answers/i);
    expect(skill.body).not.toMatch(/check queue/);
    expect(skill.body).not.toMatch(/(?:^|\s)#\d+\b|\b202\d-\d{2}-\d{2}\b|@\S+\.\S+|\/(?:Users|home)\/\w+|Claude|Codex|Kimi|Antigravity/i);
  });

  /* Which way a piece of work goes, for whoever picks it: the orchestrator and every head. */
  const WAYS = 'hh-ways-of-working';
  const ways = () => templates.skills.get(WAYS)!;

  it('tells in English and Russian which way of working fits, each way with how it starts and what not to do with it', () => {
    const skill = ways();
    expect(skill.kind).toBe('procedure');
    expect(skill.title).toEqual({ en: 'Ways of working', ru: 'Способы работы' });
    expect(skill.description.en).toMatch(/standing employees[\s\S]*turnkey[\s\S]*route[\s\S]*one-shot calls[\s\S]*chain[\s\S]*assistant[\s\S]*program operator/i);
    expect(skill.description.ru).toMatch(/постоянн[\s\S]*под ключ[\s\S]*маршрут[\s\S]*разов[\s\S]*цепоч[\s\S]*помощник[\s\S]*оператор/i);
    const body = skill.body;
    /* Seven ways, each in its own paragraph that says what not to do with it. */
    const sections = body.split(/^\*\*\d\. /m).slice(1);
    expect(sections.map(s => s.split('.')[0])).toEqual(['Standing employees', 'Turnkey', 'Route of stages', 'One-shot calls', 'Chains', 'Personal assistants', 'The program operator and Operations']);
    for (const section of sections) expect(section.split('\n\n')[0]).toMatch(/\b(?:Do not|Never|not a way|does not replace)\b/);
    expect(sections[0]).toMatch(/add_tasks[\s\S]*create_task[\s\S]*message_employee/);
    for (const word of ['"Works turnkey"', 'create_task', 'report']) expect(sections[1], word).toContain(word);
    expect(sections[2]).toMatch(/create_task[\s\S]*resultKind document[^.]*submit[^.]*no commit/);
    expect(sections[3]).toMatch(/independent proposals or checks[\s\S]*assigned owner verifies[\s\S]*standing employee/i);
    expect(sections[4]).toMatch(/holder[^.]*drives|drives[^.]*holder/);
    expect(sections[5]).toMatch(/not a way to give out work/);
    expect(sections[6]).toMatch(/program_screen[\s\S]*tell_orchestrator/);
    /* Every tool it names is one the server registers. */
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const registered = new Set([FIND, USE, ...readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts')).flatMap(f => [...readFileSync(join(src, f), 'utf8').matchAll(/(?:registerTool|tool)\(\s*'([a-z_]+)'/g)].map(m => m[1]!))]);
    const named = [...new Set([...body.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(m => m[0]))];
    for (const tool of [...named, 'calls', 'submit', 'report', 'verdict']) expect(registered.has(tool), tool).toBe(true);
  });

  it('decides the way by signals, shows the patterns of chains and who drives them, and ends with which to use when', () => {
    const body = ways().body;
    const signals = body.split('\n### ').find(part => part.startsWith('Read the signals'))!;
    for (const signal of [/\bSize\b/, /Independent pieces/, /Memory and questions midway/, /phone, a browser or a sign-in/, /Cost/, /tokens/, /plan's limits/, /Independent check/]) expect(signals, String(signal)).toMatch(signal);
    const patterns = body.split('\n### ').find(part => part.startsWith('Patterns'))!;
    for (const pattern of [/hard bug[\s\S]*hypothes[\s\S]*verif/i, /scan[\s\S]*synthesis/i, /language versions[\s\S]*native speaker/i, /variants[\s\S]*tournament/i, /audit[\s\S]*file[\s\S]*one report/i]) expect(patterns, String(pattern)).toMatch(pattern);
    expect(body.split('\n### ').at(-1)).toMatch(/^Which to use when\n/);
  });

  it('locks the ways of working on for the orchestrator and every head, read as a file when it is needed, and for nobody else', () => {
    expect(ORCHESTRATOR_SKILLS).toContain(WAYS);
    expect(orchestratorSteady(templates).skills.map(f => f.name)).toContain(WAYS);
    const heads = roles.filter(role => role.kind === 'head');
    expect(heads).toHaveLength(TEMPLATE_KEYS.length);
    for (const head of heads) {
      expect(head.skills.find(s => s.id === WAYS), head.id).toEqual({ id: WAYS, on: true, locked: true });
      const rendered = render(head, []);
      expect(rendered.skills.map(f => f.name), head.id).toContain(WAYS);
      expect(rendered.text, head.id).toContain(`\n- ${WAYS}: `);
    }
    expect(roles.filter(role => role.skills.some(s => s.id === WAYS)).map(role => role.id).sort()).toEqual(heads.map(head => head.id).sort());
  });

  it('names no company, product or programming language in the ways of working, with no long dash, curly quote or ё', () => {
    const text = [ways().body, ways().title.en, ways().title.ru, ways().description.en, ways().description.ru].join('\n');
    expect(text).not.toMatch(INCIDENT_OR_BRAND_LEAK_RE);
    expect(text).not.toMatch(INCIDENT_ATTRIBUTION_RE);
    expect(text).not.toMatch(/\b(?:anthropic|openai|gemini|avaclone|openclaw|hermes|telegram|google|acme)\b/i);
    expect(text).not.toMatch(/\b(?:TypeScript|JavaScript|Python|Rust|Ruby|PHP|Kotlin|Java|React)\b/);
    expect(text).not.toMatch(/[–—‘’“”ёЁ]/);
  });

  it('includes hh-tables in CORE_SKILLS and ORCHESTRATOR_SKILLS, forbids refusing spreadsheet delivery, and keeps DEV-HEAD within limits', () => {
    expect(CORE_SKILLS).toContain('hh-tables');
    const skill = templates.skills.get('hh-tables');
    expect(skill).toBeDefined();
    expect(skill!.title.en.length).toBeGreaterThan(3);
    expect(skill!.title.ru?.length).toBeGreaterThan(3);
    expect(skill!.description.en.length).toBeGreaterThan(10);
    expect(skill!.description.ru?.length).toBeGreaterThan(10);
    expect(skill!.body).toContain('hh-xlsx');
    expect(skill!.body).toContain('hh-attach');
    expect(skill!.body).toContain('send_telegram_file');
    expect(skill!.body).toContain('create_google_sheet');
    expect(skill!.body).toMatch(/error/i);
    expect(skill!.body).toMatch(/no such capability|cannot generate files/i);
    expect(skill!.body).not.toMatch(/(?:^|\s)#\d+\b|\b202\d-\d{2}-\d{2}\b|@\S+\.\S+|\/(?:Users|home)\/\w+/i);
    expect(skill!.body).not.toMatch(/(?<=[a-z,;:]\s)(?!Markdown\b|Telegram\b|Google\b|Sheets\b|Company\b)[A-Z][a-z]+/);
    expect(skill!.body).not.toContain('\u2014');
    expect(`${skill!.title.ru} ${skill!.description.ru}`).not.toContain('\u0451');
    expect(`${skill!.title.ru} ${skill!.description.ru}`).not.toContain('\u2014');

    const withMarkers = render(templates.roles.get('DEV-HEAD')!, [], { name: 'AgentMarker', company: 'TenantMarker', department: 'DeptMarker' });
    const tablesPart = withMarkers.parts.find(part => part.kind === 'skill' && part.id === 'hh-tables');
    expect(tablesPart?.text).toBeDefined();
    expect(tablesPart!.text).not.toMatch(/TenantMarker|DeptMarker|AgentMarker/);

    for (const roleId of ['DEV-HEAD', 'MKT-HEAD', 'MKT-SEO']) {
      const role = templates.roles.get(roleId)!;
      const rendered = render(role, role.skills.filter(s => s.on).map(s => s.id));
      expect(rendered.raw).toContain('<!-- hh:skill hh-tables -->');
    }
    expect(orchestratorSteady(templates).parts.map(part => part.text).join('\n\n')).toContain('<!-- hh:skill hh-tables -->');
  });
});

type SingleReleaseRunSkills = {
  leadTasks: string;
  runChecks: string;
  devLead: string;
  devTaskFlow: string;
  devGates: string;
  devCiRelease: string;
  devTdd: string;
  devTestEnv: string;
  devImplement: string;
  devPolicy: string;
  briefMembers: string;
  orchPlanTurn: string;
  orchCompany: string;
};

const SINGLE_RELEASE_RUN_RULES: { id: string; holds: (s: SingleReleaseRunSkills) => boolean }[] = [
  {
    id: 'no-turnkey-merge-and-release-ambiguity',
    holds: s =>
      forbidsAll(Object.values(s).join('\n'), [
        /from code and checks to merge and release/i,
        /tests,\s*merge and release/i,
        /\brun_tests\b[^.!?\n]*\bevery\s+(?:task|turnkey)\s+branch\b/i,
        /use\s+`?"?run_tests`?"?\s+(?:for\s+one\s+)?(?:only\s+)?when\s+your\s+(?:own\s+)?workspace\s+cannot\s+run\s+it/i,
        /\bstrictly once\b/i,
      ]),
  },
  {
    id: 'local-branch-checks-and-hand-in',
    holds: s => matchesAll(s.devTaskFlow, [/\bbuild\b[\s\S]*\btypes\b[\s\S]*\blint\b/i, /\bhand\w*\s+in\b[\s\S]*\bbranch\b|\bbranch\b[\s\S]*\bhand\w*\s+in\b/i]),
  },
  {
    id: 'the-release-relies-on-the-repositorys-ci',
    holds: s => /affected tests in your workspace|local tests of the files it reaches/i.test(s.runChecks) && /release does not use run_tests: it relies on the repository's own CI/i.test(s.runChecks) && /relies on the repository's own CI for that exact commit[\s\S]*never replace them with a run of your own machines/i.test(s.devCiRelease),
  },
  {
    id: 'lead-tasks-preserves-coordination-and-hold-meaning',
    holds: s =>
      matchesAll(s.leadTasks, [
        /before the final gate starts[\s\S]*holds its context/i,
        /Builders build and reviewers review[^.!?\n]*nobody approves their own independent gate/i,
        /Do not start a new chain merely to find a free member\./,
        /A report that claims success without evidence is treated as not done\./,
        /this ability imposes no default downstream chain/i,
        /document result/i,
        /`pause_task` with the reason/,
      ]),
  },
];

/* The conveyor never stops: finished work joins the turn at once, a release takes the commit the repository's CI checked, and
   nothing is committed only to record proof or a note. */
describe('work joins the turn at once and leaves no record-only commits', () => {
  const skill = (id: string) => templates.skills.get(id)!.body;

  it('has a developer take its checked branch into the turn branch itself, waiting for no go-ahead and no release', () => {
    expect(skill('dev-task-flow')).toMatch(/Hand in the branch yourself[\s\S]*take the open turn branch into it[\s\S]*fast-forward the turn branch/);
    expect(skill('dev-task-flow')).toMatch(/Wait for nobody's go-ahead, for no release to ship and for no next turn to open/);
    expect(skill('dev-task-flow')).toMatch(/a clean merge needs no new checks/);
  });

  it('keeps the turn branch going while the repository\'s CI checks a frozen candidate', () => {
    expect(skill('dev-lead')).toMatch(/never tell anyone to hold a finished result/i);
    expect(skill('dev-ci-release')).toMatch(/keep progressing later work while CI checks the frozen candidate/i);
    expect(skill('dev-ci-release')).toMatch(/record the checked release revision with release_turn[\s\S]*green CI records the release with no run, red or unfinished CI refuses[\s\S]*a repository with no CI records with no run/i);
  });

  it('uses the evidence of the turn\'s batch stages when the autonomous route accepts it', () => {
    expect(skill('dev-ci-release')).toMatch(/when the applicable autonomous route accepts the evidence of the turn's batch stages[\s\S]*Review, Security and Tests results of the turn branch/i);
  });

  /* One rule on proof, beside the rule that everything made goes into the repository: an agent reads no exception into
     either. A task may ask for its proof in the repository; raw output never goes there. */
  it('records proof with the hand-in and keeps raw logs out of commits', () => {
    expect(skill('hh-task-flow')).toMatch(/record verification output with the hand-in[\s\S]*attach larger logs there/i);
    expect(skill('hh-task-flow')).toMatch(/commit durable evidence only when the assignment or repository requires it[\s\S]*secrets and raw logs removed/i);
  });

  it('writes the release notes once per release, with no note committed per task', () => {
    expect(skill('dev-release-notes')).toMatch(/once, as the release is prepared, in one commit: nobody adds a note per task/);
  });
});

describe("the release relies on the repository's CI", () => {
  const bundle = (): SingleReleaseRunSkills => ({
    leadTasks: templates.skills.get('hh-lead-tasks')!.body,
    runChecks: templates.skills.get('hh-run-checks')!.body,
    devLead: templates.skills.get('dev-lead')!.body,
    devTaskFlow: templates.skills.get('dev-task-flow')!.body,
    devGates: templates.skills.get('dev-gates')!.body,
    devCiRelease: templates.skills.get('dev-ci-release')!.body,
    devTdd: templates.skills.get('dev-tdd')!.body,
    devTestEnv: templates.skills.get('dev-test-environment')!.body,
    devImplement: templates.skills.get('dev-implement')!.body,
    devPolicy: templates.skills.get('dev-testing-policy')!.body,
    briefMembers: templates.skills.get('hh-brief-members')!.body,
    orchPlanTurn: templates.skills.get('orch-plan-turn')!.body,
    orchCompany: templates.skills.get('orch-company')!.body,
  });

  it("checks a change by local tests of what it touched and leaves the whole suite to the repository's CI for the release", () => {
    expect(failedRuleIds(SINGLE_RELEASE_RUN_RULES, bundle())).toEqual([]);
  });

  it('rejects re-introducing turnkey merge-and-release ambiguity, workspace-fallback run_tests or strictly-once wording', () => {
    const base = bundle();
    expect(failedRuleIds(SINGLE_RELEASE_RUN_RULES, base)).toEqual([]);
    expect(
      failedRuleIds(SINGLE_RELEASE_RUN_RULES, { ...base, devLead: `${base.devLead}\nThat member does it from code and checks to merge and release.` }),
    ).toContain('no-turnkey-merge-and-release-ambiguity');
    expect(
      failedRuleIds(SINGLE_RELEASE_RUN_RULES, { ...base, runChecks: `${base.runChecks}\nCall run_tests on every turnkey branch before review.` }),
    ).toContain('no-turnkey-merge-and-release-ambiguity');
    expect(
      failedRuleIds(SINGLE_RELEASE_RUN_RULES, { ...base, runChecks: `${base.runChecks}\nUse "run_tests" for one only when your own workspace cannot run it.` }),
    ).toContain('no-turnkey-merge-and-release-ambiguity');
    expect(
      failedRuleIds(SINGLE_RELEASE_RUN_RULES, { ...base, leadTasks: `${base.leadTasks}\nRun run_tests strictly once ever.` }),
    ).toContain('no-turnkey-merge-and-release-ambiguity');
  });
});
