import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const watchdog = templates.skills.get('ops-task-watch')!.body;

describe('what the watchdog tells an idle department', () => {
  it('notices runnable work even when one eligible member is free', () => {
    expect(watchdog).toMatch(/runnable work has an eligible free owner[\s\S]*tell the department head/i);
    expect(watchdog).not.toMatch(/two or more members/i);
  });

  it('keeps running dependencies active and assigns failures for repair', () => {
    expect(watchdog).toMatch(/tests, delegated work, another task and scheduled retries stay in progress with owners and timers/i);
    expect(watchdog).toMatch(/waits only for an indispensable action from a named person/i);
    expect(watchdog).toMatch(/assign failed prerequisites to the owner who can repair them/i);
  });

  it('reports actionable work and leaves assignment decisions to the head', () => {
    expect(watchdog).toMatch(/which work and capacity you observed[\s\S]*leave assignment choices with the head/i);
    expect(watchdog).toMatch(/assignment changes or the head records why the work cannot start/i);
    expect(watchdog).toMatch(/misses the agreed response time or the observed impact warrants earlier help/i);
    expect(watchdog).not.toMatch(/two rounds|thirty minutes|#\d|\b20\d\d\b|\u2013|\u2014/);
  });
});
