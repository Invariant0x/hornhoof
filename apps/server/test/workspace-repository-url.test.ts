import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceRepositoryUrl } from '../src/db/workspace-repository-url.js';

describe('registered workspace repository identity', () => {
  it.each([
    ['https://Git.Example/team/repo.git', 'https://git.example/team/repo'],
    ['https://git.example:443/team/repo.git/', 'https://git.example/team/repo'],
    ['https://git.example/team/repo/', 'https://git.example/team/repo'],
    ['https://fixture-user:fixture-password@git.example/team/repo.git', 'https://git.example/team/repo'],
    ['https://git.example:8443/team/repo.git', 'https://git.example:8443/team/repo'],
    ['https://git.example/team/Repo.git', 'https://git.example/team/Repo'],
    ['https://git.example/team/repo.GIT', 'https://git.example/team/repo.GIT'],
  ])('normalizes only supported HTTPS configuration %s', (input, expected) => {
    expect(canonicalWorkspaceRepositoryUrl(input)).toBe(expected);
  });

  it('keeps different remotes and case-sensitive paths distinct despite equal basenames', () => {
    const inputs = ['https://one.example/team/app.git', 'https://two.example/team/app.git', 'https://one.example/other/app.git', 'https://one.example/team/App.git'];
    const identities = inputs.map(canonicalWorkspaceRepositoryUrl);
    expect(identities.every(value => value !== null)).toBe(true);
    expect(new Set(identities).size).toBe(inputs.length);
  });

  it.each([
    '', '/team/repo', 'git@example.test:team/repo.git', 'ssh://git.example/team/repo',
    'http://git.example/team/repo', 'file:///tmp/repo', 'not a URL',
    'https://git.example/', 'https://git.example/.git',
    'https://git.example/team/repo?credential=fixture', 'https://git.example/team/repo#branch',
    ' https://git.example/team/repo', 'https://git.example/team/repo\n',
    'https://git.example/team/\u00a0repo', 'https://git.example/team/\u2003repo',
    'https://git.example/team\\repo', 'https:///git.example/team/repo',
  ])('refuses unsupported or ambiguous identity %j', input => {
    expect(canonicalWorkspaceRepositoryUrl(input)).toBeNull();
  });
});
