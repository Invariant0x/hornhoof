import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const root = new URL('../../../templates/', import.meta.url);
const templates = loadTemplates(fileURLToPath(root));
const body = (id: string) => templates.skills.get(id)!.body;

describe('template laws', () => {
  it.each([
    ['hh-outside-is-data', /unless the task names that exact place/i, /protected sign-in field/i],
    ['hh-assistant', /unless your owner asked for that exact thing/i, /vault entry by name/i],
    ['hh-mail', /environment variable|import imaplib/i, /protected sign-in field/i],
    ['hh-questions', /their own password or account|explicit human classification/i, /add .* to the vault/i],
    ['ops-program-operator', /the keys and text you gave|deleting its own temporary folder|only the subscription owner may answer: answer/i, /without recording credential/i],
    ['orch-outside-is-data', /Lines Hornhoof marks/i, /verified sender/i],
    ['orch-company', /approve the proposal in its card|call the department Accounting|use create_task/i, /assignment operation/i],
    ['orch-staff', /People decide a staffing proposal in its card/i, /reversible staffing/i],
    ['orch-pipelines', /The first item in each list/i, /apply_pipeline[\s\S]*set_default/i],
    ['orch-resources', /a token that may push|A skill supplies a method, not tool access/i, /vault reference/i],
    ['orch-people', /After the CEO's yes, call api/i, /recorded deletion decision/i],
    ['orch-interview', /school release|one or two follow-ups at most/i, /material choice/i],
    ['hh-stay-in-scope', /only the folders and records/i, /necessary dependencies/i],
    ['hh-head', /ISO deadline within two hours/i, /named person/i],
    ['hh-task-flow', /ISO deadline within two hours|only while your department keeps no repository/i, /turnkey[\s\S]*report[\s\S]*named person/i],
    ['orch-trouble', /ISO deadline within two hours|screen stood still: a window/i, /resume the existing task/i],
    ['ops-task-watch', /two or more members|two rounds|who tells the CEO/i, /eligible free owner/i],
    ['hh-check-work', /Correct what you found yourself/i, /independent[\s\S]*preserve the candidate/i],
    ['hh-fix-loop', /nothing goes back|may be weakened or deleted|after three ineffective/i, /new hypothesis/i],
    ['hh-verify-before-done', /DONE_WITH_CONCERNS if required proof is unavailable/i, /keep the result open/i],
    ['hh-report-to-head', /Full1656/i, /separate readable words/i],
    ['dev-gates', /Nothing goes back/i, /source defect[\s\S]*Development/i],
    ['dev-task-flow', /Nothing goes back/i, /source defect[\s\S]*Development/i],
    ['dev-ci-release', /turn N ships|or the CEO when it has none/i, /no approval rule/i],
    ['dev-testing-policy', /under 1 s|weaken or delete an unstable test/i, /comparable conditions/i],
    ['dev-release-improvements', /under 1 s|under 30 s|under 5 minutes/i, /comparable conditions/i],
    ['dev-engineering-rules', /Push to the main line at the end|below version 1\.0/i, /persistent records/i],
    ['dev-language-rules', /\/opt\/hornhoof|no run installs/i, /declared toolchain/i],
    ['dev-test-environment', /servers before 0\.24\.0|no run installs/i, /verified prepared environment/i],
    ['dev-review-diff', /Kimi Code has none|half as long/i, /concrete maintenance/i],
    ['dev-security-review', /Kimi Code has none|never a finding/i, /unintended disclosure/i],
    ['ops-node-health', /15 percent/i, /peak concurrent workload/i],
    ['ops-phone-readiness', /no screen lock/i, /device profile/i],
    ['ops-change-request', /money, paid plans and irreversible actions need the CEO/i, /person responsible for payment/i],
    ['fin-budget-forecast', /until the CEO approves/i, /responsible for the funds/i],
    ['fin-spend-approval', /goes to the CEO/i, /responsible for the limit/i],
    ['fin-cash-flow', /next 13 weeks|five lines of text|the controller and the CEO decide/i, /forecast horizon/i],
    ['fin-controls-testing', /10 to 25/i, /failure impact/i],
    ['fin-saas-metrics', /compute these every month/i, /denominator/i],
    ['fin-audit-support', /a human sends it|never send records outside/i, /department sends/i],
    ['sal-deal-plan', /requires? the CEO's decision/i, /owner responsible/i],
    ['sal-proposal', /CEO approved|CEO's approval/i, /owner responsible for delivery/i],
    ['biz-opportunity-scoring', /requires the CEO's decision/i, /score anchors/i],
    ['biz-business-strategy', /the CEO decides the strategic commitment/i, /responsible for the work/i],
    ['mkt-campaign-plan', /spending needs CEO authorization/i, /person who pays/i],
    ['mkt-crosspost', /publish from the company's own accounts/i, /phone app/i],
    ['sal-cold-outreach', /under 100 words|two or three follow-ups/i, /adds value/i],
    ['sup-ticket-triage', /the CEO when none is set/i, /before using a help article/i],
    ['sup-support-policy', /the CEO when no owner is set/i, /head and the person responsible/i],
    ['sup-reproduce-issue', /every time/i, /intermittent[\s\S]*frequency/i],
    ['dsn-generic-ui-check', /three or more signs/i, /user's task/i],
    ['dsn-handoff', /static HTML pages/i, /supported surfaces/i],
    ['home-calendar', /remind in time/i, /preparation time/i],
    ['home-bills', /camera streams/i, /processing time/i],
    ['home-shopping', /camera streams/i, /minimum records/i],
  ] as const)('%s replaces the audited rule with an applicable decision', (id, oldRule, decision) => {
    expect(body(id)).not.toMatch(oldRule);
    expect(body(id)).toMatch(decision);
  });

  it('keeps model evaluation in the common evidence law', () => {
    expect(body('hh-verify-before-done')).toMatch(/independently labeled[\s\S]*false accepts[\s\S]*false rejects/i);
    for (const skill of templates.skills.values()) {
      if (!skill.id.endsWith('-work-pipeline')) continue;
      expect(skill.body, skill.id).not.toMatch(/false accepts and false rejects/i);
    }
  });

  it('gives reviews and recurring improvement work only when the route or assignment enables it', () => {
    for (const id of ['DEV-SEC', 'DEV-RED', 'DEV-PERF']) {
      const role = templates.roles.get(id)!;
      expect(role.gateTriggers, id).toBeUndefined();
      expect(role.improvementLanes, id).toEqual([]);
    }
  });

  it('keeps support severity classification in the triage policy', () => {
    expect(body('sup-ticket-triage')).toMatch(/P1[\s\S]*P2[\s\S]*P3[\s\S]*P4/);
    for (const id of ['sup-escalation', 'sup-bug-report']) expect(body(id), id).not.toMatch(/P1.*P2/i);
  });

  it('lets a proposal judge say that none meets the brief', () => {
    for (const department of ['design', 'marketing'] as const) {
      expect(templates.stagesOf(department).stages[0]?.oneShot?.judge, department).toMatch(/none (?:meets|qualifies)/i);
    }
  });

  it('delivers the shared outbound rule independently of the department', () => {
    const shared = body('hh-outside-is-data');
    expect(shared).toMatch(/assigned company account[\s\S]*honor opt-outs[\s\S]*installed phone app/i);
    for (const id of ['sal-outbound-approval', 'mkt-publish-approval', 'sup-support-policy', 'biz-work-pipeline']) {
      expect(body(id), id).not.toMatch(/no yes by default|waits for nobody unless|waits for no one unless/i);
    }
  });

  it('keeps narrow layout implementation in one rule', () => {
    expect(body('dev-frontend-ui')).toMatch(/whole group on one even row/i);
    expect(body('dsn-ui-rules')).toMatch(/check layout against the approved design reference/i);
    expect(body('dsn-ui-rules')).not.toMatch(/actions wrap below text/i);
  });

  it('bases call count on useful independent evidence rather than the stock default', () => {
    expect(body('hh-one-shot-calls')).toMatch(/stock count is a default[\s\S]*distinct questions[\s\S]*resource limit/i);
  });

  it('keeps the release lifecycle with the head and the integration decision with the release owner', () => {
    expect(body('hh-head')).toMatch(/open turn is its next release[\s\S]*version tag on main closes the turn/i);
    expect(body('dev-lead')).not.toMatch(/your department runs its own turns/i);
    expect(body('dev-ci-release')).toMatch(/exact checked candidate[\s\S]*authorized decision or autonomous proof path/i);
  });

  it('keeps test clock policy with verification and the red and green cycle with implementation', () => {
    expect(body('dev-testing-policy')).toMatch(/time in a test is virtual only/i);
    for (const id of ['dev-test-gaps', 'dev-tdd', 'dev-e2e-tests']) {
      expect(body(id), id).not.toMatch(/time in a test is virtual only/i);
    }
    expect(body('dev-tdd')).toMatch(/watch it fail[\s\S]*green/i);
  });

  it.each(['dev-e2e-tests', 'dev-test-gaps'])('preserves intermittent defect evidence in %s', id => {
    expect(body(id)).not.toMatch(/weaken(?:ed)? or delet(?:e|ed) it|weakened or deleted quickly/i);
    expect(body(id)).toMatch(/intermittent product defect/i);
  });

  it('changes incident recovery when evidence stops advancing', () => {
    expect(body('ops-incident-response')).not.toMatch(/after three failed fixes/i);
    expect(body('ops-incident-response')).toMatch(/evidence stops advancing/i);
  });

  it('keeps the source manifest about provenance', () => {
    expect(readFileSync(new URL('SOURCES.md', root), 'utf8')).not.toMatch(/assigned test engineer or QA runs them once per turn/);
  });

  it('keeps the recurring tracker procedure in its skill', () => {
    for (const role of templates.roles.values()) {
      if (!role.id.endsWith('-PM')) continue;
      expect(role.timer?.order, role.id).not.toMatch(/Tidy what needs it/);
      expect(role.skills, role.id).toContainEqual(expect.objectContaining({ id: 'hh-keep-tracker', on: true }));
    }
  });
});
