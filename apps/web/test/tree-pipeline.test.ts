import type { PipelineHead, PipelineRow, PipelineTurn } from '@hornhoof/protocol/pipeline-report';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { changeText, changeTone, comparedTurns, metricLabel, msText, valueText } from '../src/screens/tree-pipeline';

const row = (over: Partial<PipelineRow>): PipelineRow => ({ section: 'time', key: 'wholeTurn', unit: 'seconds', value: 60, previous: null, baseline: null, vsPrevious: null, vsBaseline: null, ...over });
const turn = (number: number): PipelineTurn => ({ number, title: `Turn ${number}`, status: 'closed', openedAt: '2026-11-04T14:16:00.000Z', closedAt: '2026-11-04T21:00:00.000Z', source: 'closed' });
const head = (previous: number | null, baseline: number | null): PipelineHead => ({ turn: turn(9), previous: previous === null ? null : turn(previous), baseline: baseline === null ? null : turn(baseline), turns: [9, 8, 7] });

describe('metricLabel', () => {
  it.each([
    ['toAcceptance.median', 'From issue to acceptance, median'],
    ['stages.fixes', 'Fixes'],
    ['agents.lost', 'Interrupted'],
    ['waits.testRuns.partQueue', 'Test runs: parts waiting for a machine'],
    ['waits.external.employee.seconds', 'Waiting for an employee: total'],
    ['waits.queue.count', 'Waiting in the queue: times'],
    ['kinds.bug.toAcceptance', 'Bug: from issue to acceptance, median'],
    ['kinds.unset.tasks', 'Kind not set: tasks'],
    ['tests.package.apps/server', 'apps/server'],
    ['tests.package.packages/my.lib', 'packages/my.lib'],
  ])('names %s', (key, label) => {
    expect(metricLabel(en, key)).toBe(label);
  });

  it.each(['something.new', 'waits.testRuns.fresh', 'waits.fresh.count', 'kinds.fresh.tasks', 'kinds.bug.fresh'])('shows %s of a newer server as it came', key => {
    expect(metricLabel(en, key)).toBe(key);
  });

  const every = [
    'tasks.total', 'tasks.done', 'tasks.cancelled', 'tasks.open',
    'toAcceptance.median', 'toAcceptance.worst', 'toFirstSubmit.median', 'toFirstSubmit.worst', 'wholeTurn', 'criticalPath', 'agents.total',
    'stages.work', 'stages.review', 'stages.fixes', 'stages.merge', 'stages.turnReview',
    'agents.work', 'agents.waiting', 'agents.idle', 'agents.lost', 'agents.queued', 'agents.unknown',
    ...['testRuns', 'workRuns'].flatMap(name => ['count', 'seconds', 'worst', 'partQueue', 'partRun', 'parts'].map(part => `waits.${name}.${part}`)),
    ...['external.employee', 'external.time', 'external.ceo', 'external.machine', 'external.other', 'person', 'tasks', 'queue'].flatMap(name => ['count', 'seconds'].map(part => `waits.${name}.${part}`)),
    'submitsPerTask', 'failures', 'interrupted', 'selectionMisses', 'quality.laterBugs', 'returns', 'fixRounds',
    ...['bug', 'known_behavior', 'unknown_path', 'legacy_code', 'unset'].flatMap(kind => ['tasks', 'toAcceptance', 'returns', 'fixRounds', 'laterBugs'].map(part => `kinds.${kind}.${part}`)),
    'tests.total', 'tests.setup', 'tests.run', 'tests.teardown', 'tests.files',
  ];

  it.each(every)('has words for %s in both languages', key => {
    expect(metricLabel(en, key)).not.toBe(key);
    expect(metricLabel(ru, key)).not.toBe(key);
    expect(metricLabel(ru, key)).not.toMatch(/ё/);
  });
});

describe('valueText', () => {
  it.each([
    [row({ value: 12.5 }), '12.5 s', '12,5 с'],
    [row({ value: 59 }), '59 s', '59 с'],
    [row({ value: 0 }), '0 s', '0 с'],
    [row({ value: 60 }), '1 min', '1 мин'],
    [row({ value: 5400 }), '1 h 30 min', '1 ч 30 мин'],
    [row({ unit: 'count', value: 3 }), '3', '3'],
    [row({ unit: 'count', value: 0 }), '0', '0'],
    [row({ unit: 'ratio', value: 1.5 }), '1.5', '1,5'],
    [row({ value: null }), 'no data', 'нет данных'],
  ])('writes %j', (given, english, russian) => {
    expect(valueText(en, given)).toBe(english);
    expect(valueText(ru, given)).toBe(russian);
  });

  it('says test selection has no data yet rather than zero', () => {
    expect(valueText(en, row({ section: 'problems', key: 'selectionMisses', unit: 'count', value: null }))).toBe('no data yet, comes with test selection');
    expect(valueText(en, row({ section: 'problems', key: 'failures', unit: 'count', value: null }))).toBe('no data');
  });
});

describe('msText', () => {
  it.each([[1410, '1.4 s'], [33_531, '33.5 s'], [120_000, '2 min']])('writes %d ms', (ms, text) => {
    expect(msText(en, ms)).toBe(text);
  });
});

describe('changeText', () => {
  it.each([
    [80, 100, -20, '−20%'],
    [120, 100, 20, '+20%'],
    [100, 100, 0, '0%'],
    [5, 0, null, 'was 0'],
    [0, 0, 0, '0%'],
    [null, 100, null, 'no data'],
    [100, null, null, 'no data'],
    [null, null, null, 'no data'],
  ])('writes %s against %s', (value, base, change, text) => {
    expect(changeText(en, value, base, change)).toBe(text);
  });

  it('never writes a long dash or a hyphen as the minus', () => {
    expect(changeText(en, 80, 100, -20)).not.toMatch(/[—-]/);
  });

  it('speaks Russian', () => {
    expect(changeText(ru, 5, 0, null)).toBe('было 0');
    expect(changeText(ru, null, 5, null)).toBe('нет данных');
  });
});

describe('changeTone', () => {
  it.each([
    ['wholeTurn', -20, 'good'],
    ['wholeTurn', 20, 'bad'],
    ['failures', 50, 'bad'],
    ['waits.testRuns.seconds', -5, 'good'],
    ['tests.total', 10, 'bad'],
    ['agents.idle', 10, 'bad'],
  ])('reads a change of %s by %d%% as %s', (key, change, tone) => {
    expect(changeTone(key, change)).toBe(tone);
  });

  it.each(['tasks.total', 'tasks.done', 'tasks.open', 'kinds.bug.tasks', 'tests.files', 'agents.total', 'agents.work', 'waits.testRuns.parts'])('leaves %s without a verdict: more is neither good nor bad', key => {
    expect(changeTone(key, 40)).toBe('');
    expect(changeTone(key, -40)).toBe('');
  });

  it('has no verdict on no change or no percent', () => {
    expect(changeTone('wholeTurn', 0)).toBe('');
    expect(changeTone('wholeTurn', null)).toBe('');
  });
});

describe('comparedTurns', () => {
  it('compares with the previous and the baseline turn', () => {
    expect(comparedTurns(head(8, 7))).toEqual([{ number: 8, value: 'previous', change: 'vsPrevious' }, { number: 7, value: 'baseline', change: 'vsBaseline' }]);
  });

  it('names a turn once when it is both', () => {
    expect(comparedTurns(head(7, 7))).toEqual([{ number: 7, value: 'previous', change: 'vsPrevious' }]);
  });

  it('keeps the baseline when no previous turn is known', () => {
    expect(comparedTurns(head(null, 7))).toEqual([{ number: 7, value: 'baseline', change: 'vsBaseline' }]);
  });

  it('has nothing to compare the first turn with', () => {
    expect(comparedTurns(head(null, null))).toEqual([]);
  });
});
