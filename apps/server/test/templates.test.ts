import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, MAX_INSTRUCTIONS, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ORCHESTRATOR_SKILLS, orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { NOTEBOOK_MAX, NOTES_MAX } from '../src/modules/notebook/book.js';
import { IssueInput } from '../src/modules/tasks/review-findings.js';
import { copyTemplates, CORE_SKILLS, HEAD_SKILLS, loadTemplates, MEMBER_SKILLS } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];

describe('templates', () => {
  const body = (id: string) => templates.skills.get(id)!.body;

  it('keeps role identities short and procedure-free across every department', () => {
    for (const role of roles) {
      expect(role.body, role.id).toMatch(/^You are [^\n.!?]+\.$/);
      expect(role.body.length, role.id).toBeLessThanOrEqual(180);
      expect(role.body, role.id).not.toMatch(/\b(?:must|never|submit|handoff|small: true|run_tests)\b|\b(?:dev|hh|orch)-[a-z-]+/);
    }
  });

  it('puts virtual time next to testing only our program, and names no skill set the agents do not have', () => {
    for (const id of ['dev-testing-policy', 'dev-tdd', 'hh-run-checks', 'dev-e2e-tests']) {
      expect(body(id), id).toMatch(/we test our program, not the operating system and not other programs/);
      expect(body(id), id).toMatch(/time in a test is virtual only/);
      expect(body(id), id).not.toMatch(/superpowers|test-driven-development skill|condition-based-waiting/);
    }
    for (const id of ['dev-test-gaps', 'dev-test-environment', 'dev-review-diff']) expect(body(id), id).toMatch(/time in a test is virtual only/);
    for (const role of roles.filter(r => /we test our program/.test(r.body))) expect(role.body, role.id).toMatch(/on virtual time only\.$/);
  });

  it('keeps a shared machine, its shared browsers and a stale preparation from costing a check', () => {
    const policy = body('dev-testing-policy');
    expect(policy).toMatch(/Stop only processes you started, by their process id[\s\S]*`pkill`[\s\S]*other employees' checks/);
    expect(policy).toMatch(/shared browser folder[\s\S]*may be read-only: never install into it[\s\S]*run its test runner directly/);
    expect(policy).toMatch(/check out another commit or make a worktree[\s\S]*stale preparation, not a failed check/);
  });

  it('turns a missing command into a step within the access an employee has, and a failed write into a read before it is repeated', () => {
    const flow = body('hh-task-flow');
    expect(flow).toMatch(/`sudo: command not found`, is no reason to install it or to get around the limit[\s\S]*own user[\s\S]*goes to your head/);
    expect(flow).toMatch(/A write that Hornhoof answered with 502, 503 or 504 may have gone through: read whether it did before you repeat it/);
  });

  it('waits again after a comment or a message ended the wait before what it waits for came', () => {
    expect(body('hh-task-flow')).toMatch(/A comment or a message on the task ends your wait too[\s\S]*call "wait_for" again/);
  });

  it('connects a repository only once its branch holds a commit', () => {
    expect(body('orch-resources')).toMatch(/only once its branch exists with at least one commit[\s\S]*git ls-remote --heads[\s\S]*stops every turn of that department/);
  });

  it("lets the program operator clear a menu without a cursor and a program's own offers, keeping the session", () => {
    const operator = body('ops-program-operator');
    expect(operator).toMatch(/no cursor takes no Enter yet: press an arrow key, look again[\s\S]*then press Enter alone/);
    expect(operator).toMatch(/offer of the program itself[\s\S]*never Escape[\s\S]*compact and go on in the same session/);
    expect(operator).toMatch(/no_hold answer on an open case lifts and closes nothing[\s\S]*tell_orchestrator/);
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
    for (const id of ['hh-task-flow', 'hh-break-down']) expect(body(id), id).toMatch(/required approvals|Required approvals/i);
  });

  it('admits small work into the flow without adding an unconditional downstream chain or resetting a running gate', () => {
    for (const id of ['hh-lead-tasks', 'orch-plan-turn', 'dev-lead']) {
      const text = body(id);
      expect(text, id).toMatch(/days or hours/);
      expect(text, id).toMatch(/final gate[\s\S]*starts|final gate has not started/);
      expect(text, id).toMatch(/context/);
      expect(text, id).toMatch(/urgency flag/);
      expect(text, id).toMatch(/once that gate runs, give it as a task of its own/);
      expect(text, id).toMatch(/simple visual change/);
      expect(text, id).toMatch(/required|mandatory|protected/i);
      expect(text, id).not.toMatch(/turn is a sprint|(?:use|place it in|put it in) the next turn/i);
    }
    expect(body('orch-plan-turn')).toMatch(/independent pieces belong together, however large/);
    expect(body('orch-plan-turn')).toMatch(/reviewed, tested and released before dependent work/);
    expect(body('orch-plan-turn')).toMatch(/never tell people to start or close a turn manually/i);
  });

  /* The flow of #883: a task goes to its department's head at once, the open turn of each top-level department is its next
     release, a task joins it as its result is accepted, and the tag of the release closes it by itself. */
  it('gives each top-level department turns of its own as its releases, with the work flowing and no turn to wait for', () => {
    for (const id of ['orch-plan-turn', 'orch-company', 'hh-head', 'hh-lead-tasks', 'dev-lead']) {
      const text = body(id);
      expect(text, id).toMatch(/runs its own turns, one open at a time/i);
      expect(text, id).toMatch(/next release/);
      expect(text, id).toMatch(/repository of its own goes to its own main line/);
      expect(text, id).not.toMatch(/plan_turn|merge_turn|such work waits for a turn|outside (?:a|planned) turns?|turn runs in echelons|that turn's own goal|lays? out and closes/i);
    }
    for (const id of ['orch-plan-turn', 'hh-head', 'hh-lead-tasks', 'dev-lead']) {
      const text = body(id);
      expect(text, id).toMatch(/nothing waits for a turn/i);
      expect(text, id).toMatch(/joins it[^.]*as its result is accepted into the turn branch/);
      expect(text, id).toMatch(/tag[^.]*closes (?:the turn|it) by itself/);
    }
    for (const id of ['orch-plan-turn', 'hh-head', 'dev-lead']) expect(body(id), id).toMatch(/release_turn[^.]*before main moves/);
    expect(body('orch-plan-turn')).toMatch(/nobody picks a turn for a task or waits for one to close/);
    expect(body('orch-plan-turn')).toMatch(/edit_turn[^.]*only[^.]*title or main point/);
  });

  it('preserves named and urgent-only orders without bypassing protected integration checks', () => {
    expect(body('orch-company')).toMatch(/named orders end to end, with the department's oversight/);
    expect(body('orch-company')).toMatch(/department's oversight[\s\S]*checks[\s\S]*exact release approval/);
    expect(body('orch-company')).toMatch(/urgentOnly[\s\S]*only what the authorized person called urgent/);
    for (const id of ['dev-task-flow', 'dev-implement', 'dev-lead', 'dev-gates', 'dev-worktrees', 'dev-work-pipeline', 'dev-ci-release']) {
      expect(body(id), id).toMatch(/access, root, permissions or secrets[\s\S]*independent Security engineer[\s\S]*before[\s\S]*shared branch/);
      expect(body(id), id).toMatch(/External Review and Security engineers work only in echelon tasks/);
      expect(body(id), id).toMatch(/In an echelon task[^.]*urgent and small work and review fixes too; self-review does not replace this gate/);
      expect(body(id), id).toMatch(/member of a turnkey team does and releases its task end to end alone[^.]*calls no external checker/);
      expect(body(id), id).not.toMatch(/urgent work, small tasks, direct named orders/);
    }
    expect(body('dev-gates')).toMatch(/eligible reviewer is unavailable[\s\S]*candidate waiting/);
  });

  it('selects implementation checks from the task and retains the four coding cycles', () => {
    for (const id of ['dev-task-flow', 'dev-tdd', 'dev-testing-policy', 'dev-implement']) expect(body(id), id).toMatch(/(?:task|head|owner)[\s\S]*check|check assigned/i);
    const tdd = body('dev-tdd');
    for (const kind of ['Bug', 'Known behaviour', 'Unknown path', 'Legacy code']) expect(tdd, kind).toContain(kind);
    expect(tdd).toMatch(/failing test[\s\S]*run_tests/);
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

  it("has a person's assistant answer words from its window there, and write to its owner's chat from there only when asked", () => {
    const line = body('hh-assistant').split('\n').find(l => l.includes('tell_owner'));
    expect(line).toMatch(/your answer stays in the window/);
    expect(line).toMatch(/asks there to be written to in their chat/);
  });

  it("keeps every department's work as files in a repository of its own, which the orchestrator creates itself with a saved key, or offers", () => {
    const resources = body('orch-resources');
    expect(resources).toMatch(/Every department keeps at least one repository of its own/);
    expect(resources).toMatch(/letters, texts, layouts and tables/);
    expect(resources).toMatch(/any earlier version/);
    expect(resources).toMatch(/keeps none and a key is saved for it, create its first repository yourself with create_repository[\s\S]*then tell the CEO or the department's owner[\s\S]*its address/);
    expect(resources).toMatch(/no key[\s\S]*offer one to the CEO or the department's owner[\s\S]*why[\s\S]*what it takes/);
    expect(resources).toMatch(/A second repository[\s\S]*only with their word/);
    expect(resources).not.toMatch(/never create one without their word/i);
    expect(body('orch-company')).toMatch(/hands in a document in place of a commit only until it has one/);
    for (const id of ['hh-lead-tasks', 'hh-task-flow']) expect(body(id), id).toMatch(/letters, texts, layouts and tables/);
    expect(body('hh-lead-tasks')).toMatch(/a document only while the department keeps none/);
    expect(body('hh-task-flow')).toMatch(/only while your department keeps no repository/);
    expect(body('hh-head')).toMatch(/keeps no repository[\s\S]*"tell_orchestrator"/);
    for (const id of ['orch-resources', 'orch-company', 'hh-lead-tasks', 'hh-task-flow', 'hh-head']) expect(body(id), id).not.toMatch(/[—ё]/);
  });

  it('keeps task tools, waits, evidence and communication available without a role workflow', () => {
    const flow = `${body('hh-tasks')}\n${body('hh-task-flow')}`;
    for (const tool of ['task', 'tasks', 'submit', 'blocked', 'ask_person']) expect(flow, tool).toContain(`"${tool}"`);
    for (const id of ['hh-head', 'hh-task-flow']) {
      expect(body(id), id).toContain('"wait_for"');
      expect(body(id), id).toMatch(/external event[\s\S]*owner[\s\S]*ISO deadline within two hours[\s\S]*end the turn/);
    }
    expect(body('hh-task-flow')).toMatch(/Completion of "run_tests" or "run_work"[\s\S]*resumes/);
    expect(body('hh-task-flow')).toContain('hh-attach --task N FILE');
    expect(body('hh-task-flow')).toContain('hh-fetch N NAME');
    expect(body('hh-brief-members')).toContain('hh-attach --task N FILE');
    expect(body('hh-head')).toContain('Do not send the orchestrator a separate message repeating a task report');
    expect(body('hh-notebook')).toMatch(/only when[\s\S]*changes|when[\s\S]*changes/i);
  });

  it('keeps nothing old below version 1.0 and migrates data from 1.0 on', () => {
    const rules = templates.skills.get('dev-engineering-rules')!;
    const preface = rules.body.slice(0, rules.body.indexOf('Every time you are asked to make a change follow:'));
    for (const text of [preface, body('dev-plan-review')]) {
      expect(text).toMatch(/Below version 1\.0, before the first release/);
      expect(text).toMatch(/no compatibility paths, switches between old and new behaviour or data-conversion code/);
      expect(text).toMatch(/From 1\.0 on, migrate existing data/);
    }
    expect(body('dev-plan-review')).toMatch(/Small or local work needs no note/);
  });

  it('checks data compatibility by release version in the review checklist', () => {
    const data = body('dev-review-diff').split('\n').find(line => line.startsWith('4. **Data.**'))!;
    expect(data).toMatch(/Below version 1\.0, before the first release, no compatibility paths or data-conversion code/);
    expect(data).toMatch(/Correct existing records directly at release/);
    expect(data).toMatch(/From 1\.0 on, migrations safe for existing rows/);
    expect(data).toMatch(/transactions where two writes must agree, nothing trusted from outside without a check at the boundary/i);
  });

  it('offers removing what is not needed to reviewers and developers, off until someone turns it on', () => {
    for (const id of ['DEV-REV', 'DEV-ENG']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-cleanup')?.on, id).toBe(false);
  });

  it('preserves ub-mode verbatim after its applicability preface', () => {
    const rules = templates.skills.get('dev-engineering-rules')!;
    const upstream = readFileSync(fileURLToPath(new URL('./fixtures/ub-mode-SKILL.md', import.meta.url)), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').replace(/^\s*# ub-mode\s*\n/, '').trim();
    const start = rules.body.indexOf('Every time you are asked to make a change follow:');
    expect(start).toBeGreaterThan(0);
    expect(rules.body.slice(start)).toBe(upstream);
    expect(rules.body.slice(0, start)).toMatch(/task determines[\s\S]*scope and check[\s\S]*independent approvals remain in force/);
    expect(rules.sources).toEqual(['unclebob/ub-mode SKILL.md']);
    expect(rules.description.en).toMatch(/your company's rules, those rules win/);
  });

  it('puts a preface above the ub-mode quote that wins where they differ', () => {
    const rules = templates.skills.get('dev-engineering-rules')!.body;
    const preface = rules.slice(0, rules.indexOf('Every time you are asked to make a change follow:'));
    expect(preface).toMatch(/Where the quote below differs from these lines, these lines win/);
    expect(preface).toMatch(/never push or merge to the main line unless the task names that action/);
    expect(preface).toMatch(/the report is the result and its evidence, not a log of every action/);
    expect(preface).toMatch(/run crapper, dryer and mutator only when the task assigns them/);
    expect(preface).toMatch(/question the premise after three failed fixes, not two/);
  });

  it('says in SOURCES which part of dev-engineering-rules is quoted and which is written for Hornhoof', () => {
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    const row = sources.split('\n').find(line => line.startsWith('| `skills/dev-engineering-rules.md`'))!;
    expect(row).toMatch(/word for word from "Every time you are asked to make a change follow:" to the end/);
    expect(row).toMatch(/the lines above the quote are written for Hornhoof/);
    expect(sources.split('\n').find(line => line.startsWith('Every role and skill text'))).toMatch(/The lines above the quote are Hornhoof's own/);
    expect(sources.split('\n').find(line => line.startsWith('| unclebob/ub-mode |'))).toMatch(/below a preface of Hornhoof's own/);
  });

  it('names one number of failed fixes before the premise is questioned', () => {
    for (const id of ['dev-debugging', 'ops-incident-response', 'orch-trouble']) expect(body(id), id).toMatch(/three failed fixes|fails three times/);
    for (const [id, skill] of templates.skills) expect(skill.body, id).not.toMatch(/two failed fixes|fails twice/);
  });

  it('retains all testing-policy capabilities without a fixed downstream tester', () => {
    const policy = body('dev-testing-policy');
    for (let n = 1; n <= 11; n++) expect(policy, `T${n}`).toContain(`T${n}:`);
    for (const rule of [/pure functions[\s\S]*direct fast tests/, /races, locks, permissions[\s\S]*real database/, /new test file always runs/i, /configuration failure or zero tests is not a pass/, /errors\/timeouts are not kills/, /money, access and security/, /false accepts and false rejects/, /do not retry or quarantine/i, /exact candidate\/fingerprint/, /CRAP 10 or above/, /0\.8 or more/, /NOT_RUN/]) expect(policy, String(rule)).toMatch(rule);
    expect(policy).toMatch(/does not assign a downstream tester/);
    expect(policy).toMatch(/full candidate validation[\s\S]*once for its candidate/);
    expect(policy).toMatch(/after a fix rerun failed and affected checks/);
    expect(policy).toMatch(/coverage from a completed applicable run rather than starting another/);
    expect(policy).toMatch(/unchanged old complexity is recorded separately/);
    expect(body('dev-review-verdict')).toContain('requirement -> test');
    expect(body('dev-review-verdict')).toMatch(/low coverage alone is not a finding/i);
  });

  it('sets a time budget for tests and puts an over-budget file in the scope of whoever touches it', () => {
    const rule = (n: number) => body('dev-testing-policy').split('\n').find(line => line.startsWith(`- **T${n}:`))!;
    expect(rule(5)).toMatch(/a test that needs no browser takes under 1 s and its file under 30 s, and a whole run of the fast profile takes under 5 minutes of wall time/);
    expect(rule(5)).toMatch(/browser tests keep the budget their project sets/);
    expect(rule(5)).toMatch(/file over budget is a defect like a failing test/);
    expect(rule(5)).toMatch(/in scope for whoever touches it or is assigned it/);
    expect(rule(5)).toMatch(/never checked inside a test/);
    expect(rule(5)).not.toMatch(/mass-rewrite/);
    expect(rule(7)).toMatch(/name each file and test over the T5 budget/);
    expect(rule(7)).not.toMatch(/fixed-minute/);
    expect(body('dev-release-improvements')).toMatch(/files and tests over the testing policy's time budget/);
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
    expect(body('dev-gates')).toMatch(/Every executable work result of an echelon task passes Review/);
    expect(body('dev-gates')).toMatch(/Tests verifies the exact final candidate including[\s\S]*repairs/);
    expect(body('dev-review-verdict')).toMatch(/only the fixes[\s\S]*paths they affect/);
    expect(body('dev-qa-acceptance')).toMatch(/exact candidate[\s\S]*do not assume[\s\S]*shared turn/);
    expect(body('dev-qa-acceptance')).toMatch(/Never pass something because the tests are green/);
  });

  it('keeps Operations diagnosis read-only and shortcuts outside protected actions', () => {
    expect(body('ops-intake')).toMatch(/database tool, which only reads[\s\S]*SQL and why/);
    expect(body('ops-intake')).toMatch(/two or three members at once/);
    for (const id of ['ops-intake', 'ops-incident-response']) {
      expect(body(id), id).toMatch(/Read-only diagnosis and small fixes need no gates only when reversible/);
      expect(body(id), id).toMatch(/independent Security engineer[\s\S]*shared merge/);
      expect(body(id), id).toMatch(/urgent|Emergency/);
      expect(body(id), id).toMatch(/host sockets or node credentials/);
    }
    expect(body('ops-incident-response')).toMatch(/preserve logs, data and accounts/);
    const trouble = body('orch-trouble');
    for (const word of ['database', 'agent_changes', 'jobs', 'task_events', 'agent_events']) expect(trouble, word).toContain(word);
    expect(trouble).toMatch(/Database repair is not permission to change people or protected access through SQL/);
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

  it("tells the orchestrator it clears any employee's inbox with a reason, and works on an open machine in any turn but one a person without the right spoke last in", () => {
    const trouble = body('orch-trouble');
    expect(trouble).toMatch(/Any employee's inbox is open to you[\s\S]*inbox and the employee's id in employee[\s\S]*inbox_mark[\s\S]*kind, source, task and receivedBefore[\s\S]*reason/);
    expect(trouble).toMatch(/goes in that employee's log with your name, the reason and how many letters/);
    expect(trouble).toMatch(/employees mark only their own letters/);
    const resources = body('orch-resources');
    expect(resources).toMatch(/while it stays open you work there in any turn of yours[\s\S]*with no new word of anyone, except a turn whose last words came from a person other than its owner, the CEO or the CEO delegate/);
    expect(resources).not.toMatch(/runs only in a turn that answers/);
    for (const id of ['orch-trouble', 'orch-resources']) expect(body(id), id).not.toMatch(/[\u2014ё]/);
  });

  it('asks for reports to people and heads in ordinary words with spaces', () => {
    for (const id of ['hh-report-to-head', 'hh-hornhoof']) expect(body(id), id).toMatch(/ordinary words[^.]*with spaces/);
  });

  it('releases only an exact authorized candidate with real evidence and a tested rollback', () => {
    const release = body('dev-ci-release');
    for (const rule of [/0\.x\.y/, /exact 40-character commit/, /explicit yes for that exact candidate/, /Merge only the approved commit into main/, /Prove rollback first/, /never publish an unapproved task branch/i, /never skip, mute or retry a (?:failed )?check (?:merely )?to get green/i]) expect(release, String(rule)).toMatch(rule);
    expect(release).toMatch(/profile[^.]*full run[^.]*every suite and every test file anew[^.]*no earlier result/i);
    expect(release).toMatch(/narrower profile, one suite or results kept from earlier runs is no release check/i);
    expect(release).toMatch(/ask with commit before pushing[\s\S]*push only after the answer says no card is needed, or after the person's yes/i);
    expect(release).toMatch(/autonomous release[\s\S]*without sending a human (?:approval )?card/i);
    expect(body('dev-task-flow')).toMatch(/autonomous release[\s\S]*auto-approval/i);
    expect(release).not.toMatch(/live (?:node |program )?checks?|one idle node at a time|actual program's request receipt/i);
    expect(readFileSync(join(DIR, 'SOURCES.md'), 'utf8')).not.toMatch(/dryer and live checks/);
    expect(body('dev-worktrees')).toMatch(/Never force-push a shared branch/);
    expect(body('dev-worktrees')).toMatch(/Never delete a workspace with uncommitted files/);
    expect(body('dev-task-flow')).toMatch(/generic wake-up[\s\S]*cannot override an explicit restriction/);
    expect(body('orch-people')).toMatch(/CEO's explicit order[\s\S]*Never use database SQL/);
    expect(body('orch-resources')).toMatch(/only from the CEO[\s\S]*ask_computer_access[\s\S]*actual authorization/);
  });

  it('loads every role and skill', () => {
    expect(roles).toHaveLength(54);
    expect(skills).toHaveLength(182);
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    expect(skills.length).toBeGreaterThanOrEqual(40);
    for (const s of skills) expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const r of roles) expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gives every role the effort assigned to its work', () => {
    const xhigh = ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-SEC', 'DEV-ARCH', 'DEV-RED', 'DEV-PERF'];
    const high = ['DEV-HEAD', 'DEV-TEST', 'DEV-QA', 'DEV-OPS', 'OPS-FIX', 'OPS-BUGS', 'OPS-INTEG', 'BIZ-ANALYST', 'FIN-AUDIT', 'FIN-FPA', 'DSN-SYS', 'DSN-UI', 'SUP-T2', 'HOM-NET', 'SAL-AE', 'MKT-WRITE', 'MKT-EDIT', 'SAL-REV', 'SUP-QA', 'BIZ-REV'];
    for (const role of roles) expect(role.effort, role.id).toBe(xhigh.includes(role.id) ? 'xhigh' : high.includes(role.id) ? 'high' : 'medium');
  });

  it('rejects an unknown role effort and allows a role to omit it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-effort-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DIR, dir, { recursive: true });
    const file = join(dir, 'roles/development/DEV-BE.md');
    const original = readFileSync(file, 'utf8').replace(/^effort:.*\n/m, '');
    writeFileSync(file, original.replace('tier:', 'effort: extreme\ntier:'));
    expect(() => loadTemplates(dir)).toThrow(/DEV-BE\.md: effort/);
    writeFileSync(file, original);
    expect(loadTemplates(dir).roles.get('DEV-BE')!.effort).toBeUndefined();
  });

  it('copies into templates with the same roles, skills and rosters', () => {
    const copy = copyTemplates(templates);
    expect(copy.roles).toEqual(templates.roles);
    expect(copy.skills).toEqual(templates.skills);
    for (const key of TEMPLATE_KEYS) expect(copy.roster(key)).toEqual(templates.roster(key));
  });

  it('copies into templates that change apart from the ones they came from', () => {
    const copy = copyTemplates(templates);
    copy.roles.set('DEV-BE', { ...copy.roles.get('DEV-BE')!, effort: undefined });
    copy.skills.get('hh-tasks')!.title.en = 'Changed';
    expect(templates.roles.get('DEV-BE')!.effort).toBe('xhigh');
    expect(templates.skills.get('hh-tasks')!.title.en).not.toBe('Changed');
  });

  it('copies into templates whose rosters list the roles the copy holds now, in the order of the templates', () => {
    const copy = copyTemplates(templates);
    const [head, ...members] = templates.roster('development');
    copy.roles.set(head!.id, { ...copy.roles.get(head!.id)!, kind: 'member', inDefault: false });
    const inDefault = members.filter(role => role.inDefault).map(role => role.id);
    expect(copy.roster('development').map(role => role.id).slice(0, inDefault.length)).toEqual(inDefault);
    expect(copy.roster('development')).toContain(copy.roles.get(head!.id));
    expect(templates.roster('development')[0]).toBe(head);
  });

  it('keeps roles short, and every skill within what each program reads of a skill file', () => {
    for (const r of roles) expect(r.body.length, r.id).toBeLessThanOrEqual(180);
    /* Antigravity reads the first 24,000 bytes of a skill's file; its name, description and heading come on top. */
    for (const s of skills) expect(Buffer.byteLength(s.body), s.id).toBeLessThanOrEqual(22_000);
    for (const s of skills) expect(s.body.length, s.id).toBeGreaterThan(80);
  });

  it("tells every role's program its instructions with room for a full notebook, its skills going as files", () => {
    const place = { company: 'Acme', department: 'Development', product: 'Mascot' };
    for (const r of roles) {
      const agent = { id: 'a', companyId: 'c', kind: r.kind === 'head' ? 'head' : 'worker', name: 'Bruno', roleKey: r.id, skills: r.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
      const { text, skills: files } = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], place);
      expect(text.length + NOTEBOOK_MAX + NOTES_MAX * 8 + 300, r.id).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
      for (const f of files) expect(text, `${r.id} ${f.name}`).toContain(`\n- ${f.name}: `);
    }
  });

  it("gives the orchestrator his own skills, which fit his instructions with a full notebook", () => {
    expect(ORCHESTRATOR_SKILLS).toEqual([
      'hh-hornhoof', 'orch-outside-is-data', 'orch-company', 'orch-staff', 'orch-people', 'orch-resources', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks', 'hh-tables',
      'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead',
    ]);
    const steady = orchestratorSteady(templates);
    /* His core rules stay whole in his instructions; the others are files his program reads when a step needs one. */
    for (const id of ['hh-hornhoof', 'orch-outside-is-data', 'orch-company', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks', 'hh-tables']) {
      expect(steady.text, id).toContain(`<!-- hh:skill ${id} -->`);
    }
    expect(steady.skills.map(f => f.name)).toEqual(['orch-staff', 'orch-people', 'orch-resources', 'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead']);
    for (const f of steady.skills) expect(steady.text).toContain(`\n- ${f.name}: `);
    expect(steady.parts.filter(p => p.kind === 'skill').map(p => p.id)).toEqual([...ORCHESTRATOR_SKILLS]);
    /* The notebook's heading and a "[#30] " before each note come on top of its text. */
    expect(steady.text.length + NOTEBOOK_MAX + NOTES_MAX * 8 + 300).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
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
    const codes: Record<string, string> = { operations: 'OPS', development: 'DEV', design: 'DSN', marketing: 'MKT', sales: 'SAL', business_development: 'BIZ', support: 'SUP', finance: 'FIN', home_devices: 'HOM', household: 'HHD' };
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

  it('has English and Russian titles and descriptions', () => {
    for (const x of [...roles, ...skills]) {
      for (const lang of ['en', 'ru'] as const) {
        expect(x.title[lang].length, `${x.id} title ${lang}`).toBeGreaterThan(1);
        expect(x.description[lang].length, `${x.id} description ${lang}`).toBeGreaterThan(5);
      }
      expect(x.title.ru, x.id).toMatch(/[а-я]/i);
    }
  });

  it('names where every template comes from and under which licence', () => {
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.md') && f !== 'SOURCES.md');
    expect(files.length).toBe(roles.length + skills.length + templates.teams.size + templates.echelons.size);
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
    expect(ops.filter(r => r.inDefault).map(r => r.id)).toEqual(['OPS-HEAD', 'OPS-INTEG', 'OPS-ACCT', 'OPS-FIX', 'OPS-WATCH', 'OPS-BUGS', 'OPS-PROGRAM']);
    const watch = templates.roles.get('OPS-WATCH')!;
    const bugs = templates.roles.get('OPS-BUGS')!;
    expect([watch.timer?.minutes, bugs.timer?.minutes]).toEqual([10, 180]);
    /* Neither goes on a round while nothing is open or failed. */
    expect([watch.timer?.forWork, bugs.timer?.forWork]).toEqual([true, true]);
    expect(watch.skills.find(s => s.id === 'ops-task-watch')?.on).toBe(true);
    expect(bugs.skills.find(s => s.id === 'ops-failure-review')?.on).toBe(true);
    expect(templates.skills.get('ops-task-watch')!.grants).toEqual(['agents', 'message_employee', 'restart_program']);
    expect(templates.skills.get('ops-failure-review')!.grants).toEqual(['failures', 'agents', 'message_employee', 'improvements']);
    for (const r of roles) if (r.timer) expect(r.timer.order.length, r.id).toBeLessThanOrEqual(2000);
    expect(roles.filter(r => r.timer).map(r => r.id).sort()).toEqual(['OPS-BUGS', 'OPS-WATCH']);
  });

  it('tells the watchdog that a machine getting ready for an update waits and has not hung, while a silent program there is still silent', () => {
    const body = templates.skills.get('ops-task-watch')?.body ?? '';
    const rule = body.split('\n').find(line => line.includes('machineDrain')) ?? '';
    expect(rule).toMatch(/waiting or restarting/);
    expect(rule).toMatch(/do not nudge/);
    expect(rule).toMatch(/not offline/);
    expect(rule).toMatch(/silent program there is still silent/);
  });

  it('has a program operator in operations that Hornhoof calls: one for the company, with no timer, on its own procedure', () => {
    const operator = templates.roles.get('OPS-PROGRAM')!;
    expect(operator).toMatchObject({ department: 'operations', kind: 'member', tier: 'standard', perProduct: false, inDefault: true, timer: null });
    expect(operator.skills.find(s => s.id === 'ops-program-operator')).toMatchObject({ on: true });
    /* Its tools go by its role, so turning a skill off cannot take them away and turning it on cannot hand them out. */
    expect(templates.skills.get('ops-program-operator')!.grants).toEqual([]);
  });

  describe('the program operator\'s procedure', () => {
    const body = templates.skills.get('ops-program-operator')?.body ?? '';
    const step = (start: string) => body.split('\n').find(line => line.includes(start)) ?? '';

    it('starts from a picture of the screen and reads all of it as data', () => {
      expect(body.split('\n')[0]).toMatch(/^1\. .*program_screen/);
      expect(body.split('\n')[0]).toMatch(/data/);
    });

    it('acts on any employee\'s program with any keys, text and answers, the owner\'s own questions too, with only secrets masked', () => {
      const act = step('You may act on');
      for (const part of ['any employee', 'any department, plan or machine', 'program_keys', 'any keys', 'C-u', 'control keys', 'type text', 'any question', 'subscription owner', 'values of secrets']) expect(act, part).toContain(part);
      expect(act).toMatch(/program_screen again after every input/);
    });

    it('sends Hornhoof\'s own words that never went, and leaves a person\'s words alone', () => {
      const words = step('Words Hornhoof typed');
      for (const part of ['hornhoof', 'Enter', 'a person typed', 'do not send or clear them']) expect(words, part).toContain(part);
    });

    it('lifts a recovery hold only with program_recovery_release, with the case and a reason', () => {
      const hold = step('recovery hold');
      for (const part of ['program_recovery_release', 'case', 'reason', 'only way']) expect(hold, part).toContain(part);
    });

    it('ends a turn that stands itself, the orchestrator\'s and any head\'s too: a stop, a look at the queue, a safe restart, one line inside', () => {
      const stands = body.slice(body.indexOf('7. A turn that stands'), body.indexOf('\n8. '));
      for (const part of ['any employee', 'the orchestrator and the head of any department', "with no person's message", 'Never ask a person to stop a turn', 'press Stop turn or write done', 'never put this work in a wait for a person']) expect(stands, part).toContain(part);
      expect(stands).toMatch(/stop_employee and your reason[\s\S]*queue moved[\s\S]*restart_program[\s\S]*same session[\s\S]*role, skills, memory and tasks stay[\s\S]*one line inside the company/);
      expect(stands).toMatch(/program operator sends it to its head with message_employee; the head of Operations sends it to the orchestrator with tell_orchestrator/);
    });

    it('signals at once, saying which screen and why it stands, when it is unclear or nothing moves', () => {
      const stuck = step('You do not understand');
      expect(stuck).toContain('tell_orchestrator');
      expect(stuck).toContain('failed');
      expect(stuck).toMatch(/which screen it is and why it stands/);
    });

    it('keeps no key limit, and no rule against Escape or text', () => {
      expect(body).not.toMatch(/at most 20 keys|takes no Escape|Press nothing on/);
    });

    describe('on a question about permission', () => {
      const section = body.slice(body.indexOf('### Permission questions'));
      const point = (start: string) => section.split('\n').find(line => line.startsWith(`- ${start}`)) ?? '';

      it('has a section of its own after the steps', () => {
        expect(body).toContain('### Permission questions');
        expect(body.indexOf('### Permission questions')).toBeGreaterThan(body.indexOf('\n6. '));
      });

      it('allows what is harmless, its own temporary folder too', () => {
        const allow = point('Allow');
        for (const kind of ['reading', 'working folder', 'temporary folder', 'deleting its own temporary folder']) expect(allow, kind).toContain(kind);
      });

      it('denies what reaches outside the working folder, and tells the head of that agent\'s department with the picture', () => {
        const deny = point('Deny');
        for (const kind of ['outside the working folder', 'system paths', 'secrets', 'unfamiliar addresses', 'not sure']) expect(deny, kind).toContain(kind);
        for (const told of ['outcome denied', "head of that agent's department", 'picture of the screen']) expect(deny, told).toContain(told);
      });

      it('answers sign-in, consent, terms and the owner\'s own questions itself, and leaves only spending money to a person', () => {
        const owner = point('Sign-in');
        for (const kind of ['consent', 'terms', 'subscription owner', 'answer them yourself', 'program_keys']) expect(owner, kind).toContain(kind);
        expect(owner).toMatch(/costs money/);
        expect(owner).toContain('tell_orchestrator');
      });

      it('takes a fresh picture before every input and leaves its decision in the agent\'s journal', () => {
        const key = point('Take a fresh');
        expect(key).toContain('program_screen');
        expect(key).toContain('before every input');
        for (const part of ['what was asked', 'what you chose', 'why', "agent's journal"]) expect(key, part).toContain(part);
      });

      it('leaves a question about the work itself to a person', () => {
        const work = point('A question about the work');
        expect(work).toContain('ask_person');
        expect(work).toMatch(/Leave it alone/);
      });
    });
  });

  it.each([['OPS-PROGRAM', 'role'], ['OPS-HEAD', 'role'], ['orch-trouble', 'skill']] as const)('tells %s straight that it sees and acts on any employee\'s program and lifts a hold with program_recovery_release', (id, kind) => {
    /* A role says it through the skills it carries on, as a role's own line stays one short sentence. */
    const text = kind === 'role' ? templates.roles.get(id)!.skills.filter(skill => skill.on).map(skill => templates.skills.get(skill.id)!.body).join('\n') : templates.skills.get(id)!.body;
    for (const part of ['any employee', 'program_screen', 'program_keys', 'any keys', 'any question', 'subscription owner', 'values of secrets', 'program_recovery_release']) expect(text, part).toContain(part);
  });

  it('locks the program skill on for the head of Operations and the program operator, so each one hired before has it too', () => {
    for (const id of ['OPS-HEAD', 'OPS-PROGRAM']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'ops-program-operator'), id).toEqual({ id: 'ops-program-operator', on: true, locked: true });
    for (const id of ['ops-intake', 'hh-questions']) expect(templates.skills.get(id)!.body, id).toMatch(/never ask a person to stop a turn or write done/i);
  });

  /* An employee reads its role's line from the template every turn. */
  it('tells a head of Operations hired before it got the operator skill, in its own line, that it lifts a hold with program_recovery_release', () => {
    expect(templates.roles.get('OPS-HEAD')!.body).toContain('program_recovery_release');
  });

  it('names in orch-trouble exactly who acts on another employee\'s program, and why a release is refused', () => {
    const trouble = templates.skills.get('orch-trouble')!.body;
    for (const part of ['the head of Operations', 'the program operator', 'no one else', 'reliability engineer']) expect(trouble, part).toContain(part);
    for (const part of ['still runs', 'program_busy', 'no_plan', 'node_unavailable', 'protected_screen', 'input_not_proven']) expect(trouble, part).toContain(part);
  });

  it('teaches the failure collector to file an improvement as a short case, part by part as the tool takes it', () => {
    const review = templates.skills.get('ops-failure-review')!.body;
    for (const part of ['title', 'problem', 'facts', 'source', 'guesses', 'why', 'change', 'gain']) expect(review, part).toContain(`${part}:`);
  });

  it('has a turnkey team for every department, of members of that department', () => {
    const teams = [...templates.teams.values()];
    expect(teams.map(team => team.department).sort()).toEqual([...new Set(roles.map(r => r.department))].sort());
    for (const team of teams) {
      expect(team.turnkey, team.id).toBe(true);
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
    expect(templates.teams.get('DEV-TEAM')!.members).toEqual([{ role: 'DEV-ENG', count: 2 }]);
  });

  it('has the full development roster', () => {
    const dev = templates.roster('development');
    const ids = dev.filter(r => r.inDefault).map(r => r.id);
    /* The default roster has someone for every echelon: Architecture, Development, Review, Security and Tests. */
    expect(ids).toEqual(['DEV-HEAD', 'DEV-ARCH', 'DEV-ENG', 'DEV-REV', 'DEV-TEST', 'DEV-SEC']);
    expect(dev.filter(r => !r.inDefault).map(r => r.id)).toEqual(['DEV-BE', 'DEV-FE', 'DEV-OPS', 'DEV-RED', 'DEV-QA', 'DEV-DOCS', 'DEV-PERF']);
    expect(templates.roles.get('DEV-FE')!.title).toEqual({ en: 'Frontend', ru: 'Фронтенд' });
    expect(templates.roles.get('DEV-BE')!.title).toEqual({ en: 'Backend engineer', ru: 'Бэкенд-разработчик' });
    expect(templates.roles.get('DSN-UI')!.perProduct).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
    for (const id of ['DEV-ARCH', 'DEV-REV']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules'), id).toBeUndefined();
    /* Each role asks for the strength of model its work needs: the strongest where nobody checks after and a mistake costs
       most, a strong one for whoever checks others or leads a department of risky work, the lightest for simple work that
       comes in a stream, and the middle one for everyone whose work is checked after. */
    const asked: Record<string, string[]> = {
      top: ['DEV-ARCH', 'DEV-SEC'],
      deep: ['BIZ-HEAD', 'BIZ-REV', 'DEV-HEAD', 'DEV-RED', 'DEV-REV', 'DSN-QA', 'FIN-AUDIT', 'FIN-HEAD', 'MKT-EDIT', 'SAL-REV', 'SUP-QA'],
      fast: ['HHD-CAL', 'HHD-SUPPLY', 'MKT-SOCIAL', 'OPS-WATCH', 'SAL-SDR', 'SUP-T1'],
    };
    for (const role of templates.roles.values()) {
      const tier = Object.keys(asked).find(key => asked[key]!.includes(role.id)) ?? 'standard';
      expect(role.tier, role.id).toBe(tier);
    }
  });

  it.each(['DEV-ENG', 'DEV-REV', 'DEV-SEC'])('tells %s that a run starts with its dependencies prepared, and what to do when it did not', roleId => {
    const role = templates.roles.get(roleId)!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Bruno', roleKey: roleId, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    const rules = rendered.skills.find(s => s.name === 'dev-language-rules')!.body;
    expect(rules).toMatch(/dependencies come prepared/);
    expect(rules).toMatch(/installs and builds nothing first, in any language/);
    expect(rules).toMatch(/started without the harness, install from the lockfile with the project's standard command/);
    expect(rules).toMatch(/Install from the lockfile in your workspace once, and again when the lockfile changes/i);
    for (const example of ['npm scripts', 'npx --no-install']) expect(rules, example).toContain(example);
    expect(rules).toMatch(/temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies/);
    expect(rules).toMatch(/imports resolve its `node_modules`/);
    expect(rules).toMatch(/ERR_MODULE_NOT_FOUND` when a run started without the harness is not an application defect/);
    /* The rule holds in any language, and what is about npm stands apart, for that kind of project. */
    const setup = rules.split('\n').find(line => line.startsWith('4.'))!;
    expect(setup).toContain('In an npm project:');
    expect(setup.split('In an npm project:')[0]).not.toMatch(/npm|npx|node_modules|JavaScript|ESLint|Vitest|Playwright/);
  });

  it('credits every source a skill names in SOURCES.md', () => {
    const credits = readFileSync(`${DIR}/SOURCES.md`, 'utf8');
    for (const s of skills) for (const src of s.sources) expect(credits, `${s.id} ${src}`).toContain(src.split(' ')[0]);
  });

  it('allows browser installation for named workspace test files and routes whole browser suites through run_tests', () => {
    const check = templates.skills.get('dev-browser-check')!.body;
    expect(check).toMatch(/verify the browser opens/i);
    expect(check).toMatch(/install the browser there if needed/);
    expect(check).toMatch(/whole browser suite across engines uses `run_tests`/);
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
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nVerify testEvidence run and commitSha, then rerun the author's test runs to confirm.` })).toContain('t10-verify-evidence-no-rerun');
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
        expect(doc).toContain('apps/web/src/i18n/index.tsx');
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
      expect(styleBook).toContain('Version 1.3, approved by the head of Design on 2026-11-13.');
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
      expect(skill!.body).toContain('- **Materials**:');
      expect(skill!.body).toMatch(/attach[\s\S]*materials[\s\S]*question tool[\s\S]*rather than[\s\S]*(?:local )?file paths/i);
      expect(skill!.body).toMatch(/inspect[\s\S]*in full[\s\S]*before answering/i);
      const materialsLine = skill!.body.split('\n').find(line => line.startsWith('- **Materials**:')) ?? '';
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
      expect(templates.skills.get('hh-stay-in-scope')!.body).toContain('change permissions');
      expect(templates.skills.get('hh-stay-in-scope')!.body).toContain('Anything irreversible or public waits for the approval');
      expect(templates.skills.get('dev-ci-release')!.body).toMatch(/never skip, mute or retry a (?:failed )?check (?:merely )?to get green/i);
      expect(templates.skills.get('dev-testing-policy')!.body).toMatch(/do not retry or quarantine/i);
      expect(templates.skills.get('ops-task-watch')!.body).toContain('Never retry it unchanged.');
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
      expect(templates.skills.get('ops-task-watch')!.body).toContain('People who stand free while work waits are a fault, not a normal wait');
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

const NATIVE_TOOL_RE = /code-review skill|security-review skill|codex review --base|review-agent/i;

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
    holds: s => /task\.echelons/.test(s.verdict) && /Review is required for every executable result/.test(s.verdict) &&
      /failed verdict keeps ownership with you/.test(s.verdict) && /model not weaker than its producer/.test(s.verdict) &&
      /same provider, subscription or tariff is allowed/.test(s.verdict) &&
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
        /\bfirst look[\s\S]*(?:role's|card)\b/i.test(all) &&
        forbids(all, /\b(?:at|on|force|forcing|raise\s+effort\s+to)\s+high(?:\s+effort)?\b/i) &&
        forbids(repeats, /\b(?:read|reread|re-read|inspect|review)\b[^.!?;,]*\b(?:whole|entire|full)\s+(?:patch|change|branch|diff)\b/i) &&
        forbids(repeats, /\b(?:(?:re-?)?run\w*|use|invoke|repeat\w*)\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:program's own review|native review|code-review|security-review|codex review|review-agent)\b/i) &&
        /\b(?:do not|never|skip|without|no second)\b[^.!?]*\b(?:program's own review|native review|whole (?:patch|change|branch))\b/i.test(s.diff) &&
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
    id: 't10-verify-evidence-no-rerun',
    holds: s =>
      /\bcompleted results for the reviewed commit\b/.test(s.diff) &&
      /\b(?:instead of rerunning|do not rerun|never rerun)\b/i.test(s.diff) &&
      forEvery([s.verdict], text =>
        /\btask\.review\b/.test(text) &&
        /\btestEvidence\b/.test(text) &&
        /\bproves\b/.test(text) &&
        /\b(?:instead of rerunning|do not rerun|never rerun)\b/i.test(text),
      ) && forbids(`${s.diff}\n${s.verdict}\n${s.security}`, /\b(?:re-?run\w*|re-?execut\w*)\b[^.!?;,]*\b(?:author'?s?\s+|submitted\s+|its\s+)?test(?:\s+runs?|\s+suites?|s)\b/i),
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
  { id: 'named-test-files-local-red-green', holds: text => matchesAll(text, [/authoring or reviewing[\s\S]*own workspace/i, /one or more regular test files/i, /directory, glob, loop or variable/i]) && forbids(text, /\brun\w*\b[^.!?;,]*\ba directory\s+locally\b/i) },
  { id: 'quality-stages-in-own-workspace', holds: text => matchesAll(text, [/locally[\s\S]*builds[\s\S]*types[\s\S]*lint\/format[\s\S]*coverage[\s\S]*crapper[\s\S]*dryer[\s\S]*mutation/i, /whole suite[\s\S]*"run_tests"[\s\S]*groups[\s\S]*free compatible machines/i]) },
  { id: 'local-lockfile-installs', holds: text => /Install dependencies from the lockfile in your workspace once[\s\S]*lockfile changes/i.test(text) && !/Never install dependencies locally/i.test(text) },
  { id: 'prepared-dependencies-install-only-when-needed', holds: text => /manifest names its dependencies[^.]*already in place[^.]*install only when they are missing or after the lockfile changes/i.test(text) },
  { id: 'noncheck-run-work-separate-from-mixed-checks', holds: text => matchesAll(text, [/"run_work"[\s\S]*non-check work[\s\S]*not test evidence/i, /any check in a work run[\s\S]*whole suite[\s\S]*"run_tests"[\s\S]*only on the release candidate/i]) && forbids(text, /\bcount\w*\b[^.!?;,]*\brun_work\b[^.!?;,]*\bas\s+T2\b/i) },
  { id: 'unavailable-route-blocks-and-refusal-never-pass', holds: text => matchesAll(text, [/"blocked"/, /Never fall back to a local whole suite/i, /command refusal is not PASS/]) && forbidsAll(text, [/\bfall back to running the whole suite locally/i, /\btreat\w*\b[^.!?;,]*\brefusal as PASS/i]) },
  { id: 'final-stage-full-suite-and-light-screenshot', holds: text => matchesAll(text, [/assignment identifies the check scope[\s\S]*do not start a duplicate full run/i, /lightweight single-page screenshot capture is not a browser suite/i, /browser test files[\s\S]*workspace[\s\S]*browser installation is allowed/i]) },
  { id: 'abstract-english-no-incident-facts', holds: text => text.length > 200 && !hasIncidentOrBrandLeak(text) },
];

const RECONCILED_SKILL_SOURCE_RULES: { id: string; holds: (s: ReconciledCheckSkills) => boolean }[] = [
  { id: 'every-skill-that-runs-checks-references-remote-route', holds: s => forEvery(Object.values(s), text => /run_tests/.test(text)) && forEvery(Object.values(s), text => !/\bhh-run-checks\b/.test(text)) },
  { id: 'local-change-checks-and-remote-release-suite', holds: s => !/Run the whole suite locally|Send author checks through run_tests/i.test(Object.values(s).join('\n')) && /release checks[\s\S]*run_tests/i.test(s.ciRelease) && /exact candidate[\s\S]*required checks/i.test(s.ciRelease) },
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
        /\bsame internal fix fails (?:a third time|three times)\b/i,
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

describe('outbound and support gateway templates', () => {
  it('routes sales, marketing and support skills through the server-checked outbound gateway and department owner', () => {
    const sal = templates.skills.get('sal-outbound-approval')?.body ?? '';
    const mkt = templates.skills.get('mkt-publish-approval')?.body ?? '';
    const sup = templates.skills.get('sup-support-policy')?.body ?? '';

    for (const [id, body] of [
      ['sal-outbound-approval', sal],
      ['mkt-publish-approval', mkt],
      ['sup-support-policy', sup],
    ] as const) {
      expect(body, id).not.toMatch(INCIDENT_OR_BRAND_LEAK_RE);
      expect(body, id).not.toMatch(INCIDENT_ATTRIBUTION_RE);
      expect(body, id).not.toMatch(/[\u0451\u0401\u2014]/);
      expect(body, id).toMatch(/\bserver\b/i);
      expect(body, id).toMatch(/published (?:catalog|template)[\s\S]*revisions/i);
      expect(body, id).toMatch(/\bdepartment owner\b[\s\S]*\bCEO\b/i);
      expect(body, id).toMatch(/\b(?:credentials?|keys?|passwords?)\b[^.!?]*\b(?:stay|remain|kept)\b[^.!?]*\bserver\b/i);
    }

    expect(sal).toMatch(/"outbound_submit"/);
    expect(sal).toMatch(/"outbound_status"/);
    expect(sal).toMatch(/\bunknown\b[^.!?]*\b(?:receiver|receiving|resend)\b/i);
    expect(mkt).toMatch(/"outbound_submit"/);
    expect(mkt).toMatch(/\bevery public item\b[^.!?]*\bexplicit approval of its exact rendered content\b/i);
    expect(sup).toMatch(/"support_classify"/);
    expect(sup).toMatch(/"support_submit"/);
    expect(sup).toMatch(/\buntrusted data\b/i);
    expect(sup).toMatch(/\b(?:never|do not)\b[^.!?]*\b(?:refund|price|legal|contract|delivery[- ]date)\b/i);
  });

  it("delivers separate classification, catalog replies and owner escalation through each support role's abilities", () => {
    expect(templates.roles.get('SUP-T2')?.effort).toBe('high');
    for (const id of ['SUP-HEAD', 'SUP-KB', 'SUP-T1', 'SUP-T2'] as const) {
      const role = templates.roles.get(id)!;
      expect(role.body, id).toMatch(/^You are [^\n.!?]+\.$/);
      expect(role.body.length, id).toBeLessThanOrEqual(180);
      const rendered = renderInstructions(templates, { id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: 'Ari', roleKey: id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Support', product: null });
      const abilities = [rendered.text, ...rendered.skills.map(file => file.body)].join('\n');
      if (id !== 'SUP-KB') {
        expect(abilities, id).toContain('support_classify');
        expect(abilities, id).toContain('support_submit');
        expect(abilities, id).toMatch(/department owner[\s\S]*CEO/);
      } else {
        expect(abilities).toMatch(/catalog[\s\S]*knowledge|knowledge[\s\S]*catalog/);
        expect(abilities).toMatch(/publication[\s\S]*approv|approv[\s\S]*publication/i);
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
      forEvery([s.implement, s.policy], text => matchesAll(text, [/\brun_tests\b/, /\b(?:dependent|selected|affected)\s+(?:tests?|checks?)\b/i])) &&
      matchesAll(s.implement, [/\bexplicit selector\b/i]) &&
      matchesAll(s.policy, [
        /\bnew(?:ly\s+added)?\s+test\b[\s\S]*\balways\b|\balways\b[\s\S]*\bnew(?:ly\s+added)?\s+test\b/i,
        /\binput paths\b[\s\S]*\bselected inventory\b[\s\S]*\bfallback reason\b/i,
        /\brun\b[\s\S]*\bparts?\b[\s\S]*\bcommit\b/i,
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
        /\bNever assume run_tests selects by itself\b/i,
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
    expect(verdict).toMatch(/Only the current checking owner may act/);
    expect(verdict).toMatch(/failed verdict keeps ownership with you[\s\S]*fix it within the assigned paths/);
    expect(verdict).not.toContain('task.fixReview');
    expect(verdict).toMatch(/Review is required for every executable result/);
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
    expect(rendered.skills.map(file => file.name)).toEqual([skill.id]);
    expect(rendered.skills[0]!.body).toContain(skill.body);
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
    expect(body('dev-language-rules')).toContain('For a language without a folder, say so in your report');
    expect(body('dev-testing-policy')).toMatch(/Unsupported languages are NOT_RUN/);
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
    expect(ORCHESTRATOR_SKILLS).toEqual(expect.arrayContaining(['orch-company', 'orch-staff', 'orch-people', 'orch-resources']));
  });

  it('keeps the orchestrator identity short and its workflow in selected abilities', () => {
    expect(ORCHESTRATOR_INSTRUCTIONS).toMatch(/^You are [^\n.!?]+\.$/);
    expect(ORCHESTRATOR_INSTRUCTIONS.length).toBeLessThanOrEqual(180);
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/hh-lead-tasks|plan_turn|build_structure/);
    const steady = orchestratorSteady(templates);
    expect(steady.parts.map(part => part.kind)).toEqual(['base', 'assignment', ...ORCHESTRATOR_SKILLS.map(() => 'skill')]);
    expect(steady.parts[0]!.text).toBe(ORCHESTRATOR_INSTRUCTIONS);
    for (const id of ORCHESTRATOR_SKILLS) expect(steady.parts.filter(part => part.id === id)).toHaveLength(1);
  });

  it('includes hh-tables in CORE_SKILLS and ORCHESTRATOR_SKILLS, forbids refusing spreadsheet delivery, and keeps DEV-HEAD within limits', () => {
    expect(CORE_SKILLS).toContain('hh-tables');
    const skill = templates.skills.get('hh-tables');
    expect(skill).toBeDefined();
    expect(skill!.title.en.length).toBeGreaterThan(3);
    expect(skill!.title.ru.length).toBeGreaterThan(3);
    expect(skill!.description.en.length).toBeGreaterThan(10);
    expect(skill!.description.ru.length).toBeGreaterThan(10);
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
      expect(rendered.whole).toContain('<!-- hh:skill hh-tables -->');
      expect(rendered.text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
      expect(rendered.whole.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    }
    expect(orchestratorSteady(templates).whole).toContain('<!-- hh:skill hh-tables -->');
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
    id: 'local-branch-checks-and-no-per-task-run-tests',
    holds: s =>
      forEvery([s.leadTasks, s.runChecks, s.devLead, s.devTaskFlow, s.devGates, s.devTdd, s.devTestEnv, s.devImplement, s.briefMembers], text =>
        matchesAll(text, [
          /\b(?:individual|turnkey|task)\b[\s\S]*\b(?:named|affected|area)\b[\s\S]*\brun_tests\b|\brun_tests\b[\s\S]*\b(?:individual|turnkey|task)\b/i,
        ]),
      ) &&
      forEvery([s.leadTasks, s.devLead, s.devTaskFlow], text =>
        matchesAll(text, [/\bbuild\b[\s\S]*\btypes\b[\s\S]*\blint\b/i, /\bhand\w*\s+in\b[\s\S]*\bbranch\b|\bbranch\b[\s\S]*\bhand\w*\s+in\b/i]),
      ) &&
      matchesAll(s.devTaskFlow, [/no per-task run_tests \(unless this task itself assembles the final release to main\)/i]),
  },
  {
    id: 'single-full-run-on-combined-release-branch-before-main',
    holds: s =>
      forEvery([s.leadTasks, s.runChecks, s.devLead, s.devTaskFlow, s.devGates, s.devCiRelease, s.devPolicy, s.devTestEnv, s.devImplement, s.briefMembers, s.orchPlanTurn, s.orchCompany], text =>
        matchesAll(text, [/\bonce per release candidate\b[\s\S]*\bcombined release (?:branch|candidate)\b[\s\S]*\bmain\b/i]),
      ),
  },
  {
    id: 'lead-tasks-preserves-coordination-and-hold-meaning',
    holds: s =>
      matchesAll(s.leadTasks, [
        /When small work arrives, the orchestrator passes it to the head immediately\./,
        /Builders build and reviewers review[^.!?\n]*nobody approves their own independent gate/i,
        /Do not start a new chain merely to find a free member\./,
        /A report that claims success without evidence is treated as not done\./,
        /this ability imposes no default downstream chain/i,
        /letters, texts, layouts and tables as well as code, as files in its repository/,
        /`pause_task` with the reason/,
      ]),
  },
];

describe('full test suite once per release candidate before release', () => {
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

  it('requires local changed-area checks on task and turnkey branches and one run_tests run per release candidate on the combined release branch before main', () => {
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
