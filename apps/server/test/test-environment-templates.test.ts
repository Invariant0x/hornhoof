import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/test-environment-python', import.meta.url));
const owners = ['DEV-TEST', 'DEV-QA', 'DEV-HEAD', 'OPS-FIX', 'OPS-INTEG', 'OPS-HEAD'];

function runUnitTests(root: string, testDir: string, pattern = 'test_*.py'): number {
  const program = "import sys, unittest; suite = unittest.defaultTestLoader.discover(sys.argv[1], pattern=sys.argv[2]); result = unittest.TextTestRunner().run(suite); print(result.testsRun); sys.exit(not result.wasSuccessful())";
  return Number(execFileSync('python3', ['-c', program, testDir, pattern], { cwd: root, env: { ...process.env, PYTHONPATH: join(root, 'src'), PYTHONDONTWRITEBYTECODE: '1', DATABASE_URL: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
}

describe('product environment ownership', () => {
  it.each(owners)('delivers the environment procedure to a new %s hire', roleId => {
    const role = templates.roles.get(roleId)!;
    const agent = { id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: 'Mira', roleKey: roleId, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Example', department: role.department, product: 'Ledger' });
    expect(rendered.skills.map(skill => skill.name)).toContain('dev-test-environment');
    expect(rendered.text).toContain('- dev-test-environment:');
  });

  it('assigns product language choices and reuses tools only within a verified product runtime fingerprint', () => {
    const skill = readFileSync(fileURLToPath(new URL('../../../templates/skills/dev-test-environment.md', import.meta.url)), 'utf8');
    expect(skill).toMatch(/product owner and assigned environment owner choose the product's languages/);
    expect(skill).toContain('`.tool-versions`');
    expect(skill).toMatch(/fetches tools once for each product and declared runtime fingerprint/);
    expect(skill).toMatch(/Several programs/);
    expect(skill).toMatch(/changed version or preparation input invalidates/);
    expect(skill).toMatch(/another product's runtime is no evidence that this product is ready/i);
  });

  it('keeps final checks and existing role skills while adding the environment procedure', () => {
    expect(templates.roles.get('DEV-TEST')).toMatchObject({ schema: 'final_check', gate: null, inDefault: true });
    expect(templates.roles.get('DEV-QA')).toMatchObject({ schema: null, gate: null, inDefault: false });
    expect(templates.roles.get('DEV-HEAD')).toMatchObject({ schema: null, gate: null, inDefault: true });
    const previous: Record<string, string[]> = {
      'DEV-TEST': ['dev-engineering-rules', 'dev-language-rules', 'dev-test-gaps', 'dev-tdd', 'dev-e2e-tests', 'dev-browser-check'],
      'DEV-QA': ['dev-qa-acceptance', 'dev-browser-check', 'dev-i18n-en-ru'],
      'DEV-HEAD': ['dev-gates', 'dev-worktrees', 'dev-release-notes'],
      'OPS-HEAD': ['ops-intake', 'ops-change-request', 'ops-capacity-plan'],
      'OPS-FIX': ['ops-incident-response', 'ops-node-health', 'ops-runbook', 'ops-postmortem'],
      'OPS-INTEG': ['ops-connector-catalog', 'ops-api-connector', 'ops-tool-install'],
    };
    for (const [id, skills] of Object.entries(previous)) {
      const enabled = templates.roles.get(id)!.skills.filter(skill => skill.on).map(skill => skill.id);
      expect(enabled, id).toEqual(expect.arrayContaining([...skills, 'dev-test-environment']));
    }
    expect(templates.roles.get('OPS-INTEG')!.skills.find(skill => skill.id === 'ops-mcp-config-review')?.on).toBe(false);
  });
});

describe('neutral Python discovery fixture', () => {
  it.each(['.', 'no-services'])('has an unhinted README and no prepared descriptor in %s', variant => {
    const root = join(fixture, variant);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).not.toMatch(/hornhoof|mutation|mutator|cache|split|services\s*:/i);
    expect(existsSync(join(root, '.hornhoof/test-environment.json'))).toBe(false);
    expect(readFileSync(join(root, 'pytest.ini'), 'utf8')).toContain('testpaths = tests');
  });

  it('provides a real database declaration, migration and per-test reset separate from pure unit tests', () => {
    const compose = parse(readFileSync(join(fixture, 'compose.yaml'), 'utf8'));
    expect(compose.services.database.image).toBe('postgres:17.11');
    expect(readFileSync(join(fixture, 'migrations/001_baskets.sql'), 'utf8')).toContain('CREATE TABLE baskets');
    expect(existsSync(join(fixture, 'scripts/migrate.py'))).toBe(true);
    expect(existsSync(join(fixture, 'tests/db/conftest.py'))).toBe(true);
    expect(existsSync(join(fixture, 'tests/conftest.py'))).toBe(false);
    /* Parse Python with Python, then run pure tests without collecting database fixtures. */
    const checked = execFileSync('python3', ['-c', "import ast, pathlib; files = sorted(pathlib.Path('.').rglob('*.py')); [ast.parse(p.read_text()) for p in files]; print(len(files))"], { cwd: fixture, encoding: 'utf8' });
    expect(Number(checked.trim())).toBeGreaterThanOrEqual(6);
    expect(runUnitTests(fixture, 'tests/unit')).toBe(4);
  });

  it('covers the discovered inventory with disjoint file parts and runs a literal pure-file subset', () => {
    const inventory = readdirSync(join(fixture, 'tests'), { recursive: true, encoding: 'utf8' })
      .filter(path => /(^|\/)test_[^/]+\.py$/.test(path))
      .map(path => `tests/${path}`).sort();
    const parts = [['tests/db/test_baskets.py'], ['tests/unit/test_totals.py']];
    expect(parts.flat().sort()).toEqual(inventory);
    expect(new Set(parts.flat()).size).toBe(inventory.length);
    const pure = parts[1]![0]!;
    expect(runUnitTests(fixture, dirname(pure), basename(pure))).toBe(4);
  });

  it('runs the project without services with no database address', () => {
    const root = join(fixture, 'no-services');
    expect(runUnitTests(root, 'tests')).toBe(2);
  });
});
