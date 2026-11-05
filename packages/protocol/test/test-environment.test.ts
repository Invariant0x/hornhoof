import { describe, expect, it } from 'vitest';
import { Command as command, RepositoryScope as scope } from '../src/index.js';

const repoScope = {
  companyId: '10000000-0000-4000-8000-000000000001',
  repositoryOwnerId: '10000000-0000-4000-8000-000000000002',
  repoUrlHash: 'a'.repeat(64),
};

describe('product test environment boundary primitives', () => {
  it('preserves a literal command and its checkout-relative working directory', () => {
    const value = { program: 'python3', args: ['-m', 'pytest', 'tests/a file.py'], cwd: 'services/api' };
    expect(command.safeParse(value)).toMatchObject({ success: true, data: value });
    expect(command.safeParse({ ...value, cwd: '.' }).success).toBe(true);
    expect(command.safeParse({ ...value, shell: true }).success).toBe(false);
  });

  it.each(['../other', '/tmp', 'C:/outside', 'inside/../../outside', 'inside\\outside', 'bad\0path'])('refuses a working directory outside the repository contract: %s', cwd => {
    expect(command.safeParse({ program: 'node', args: [], cwd }).success).toBe(false);
  });

  it('requires server-owned UUID scope and an exact repository URL digest', () => {
    expect(scope.safeParse(repoScope)).toMatchObject({ success: true, data: repoScope });
    expect(scope.safeParse({ ...repoScope, repoUrlHash: 'a' }).success).toBe(false);
    expect(scope.safeParse({ ...repoScope, companyId: 'somebody' }).success).toBe(false);
    expect(scope.safeParse({ ...repoScope, token: 'not-a-scope-field' }).success).toBe(false);
  });
});
