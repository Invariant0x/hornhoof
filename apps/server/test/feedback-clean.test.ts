import { describe, expect, it } from 'vitest';
import { cleanText } from '../src/modules/feedback/clean.js';

/* What a report keeps of what a person or an agent wrote before it leaves the installation: secrets, keys, tokens,
   passwords, the addresses of the company's own repositories and other places, email and paths in a home folder are
   hidden, each by a mark that says what stood there. */

const hidden = (text: string) => cleanText(text).text;

describe('cleaning a report before it leaves', () => {
  it('hides API keys and tokens by the way their makers write them', () => {
    const keys = [
      'sk-ant-api03-Zx9YwVuTsRqPoNmLkJiHgFeDcBa0123456789',
      'sk-proj-4f9aZ0b1C2d3E4f5G6h7I8j9K0l1M2n3',
      'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      'gho_16C7e42F292c6912E7710c838347Ae178B4a',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS',
      'xoxb-1234567890-0987654321-AbCdEfGhIjKl',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA-1234567890abcdefghijklmnopqrstu',
      'glpat-x1Y2z3A4b5C6d7E8f9G0',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];
    for (const key of keys) expect(hidden(`The run failed with ${key} in its log.`)).toBe('The run failed with [secret] in its log.');
  });

  it('hides what follows a bearer, a password or a key named in a setting, and keeps the name', () => {
    expect(hidden('Authorization: Bearer abc.DEF-123_456')).toBe('Authorization: Bearer [secret]');
    expect(hidden('password=hunter2 and then')).toBe('password=[secret] and then');
    expect(hidden('PASSWORD: "correct horse battery"')).toBe('PASSWORD: [secret]');
    expect(hidden("api_key = 'abc123'")).toBe('api_key = [secret]');
    expect(hidden('HORNHOOF_SECRET=c2VjcmV0 NODE_KEY=nodekey1')).toBe('HORNHOOF_SECRET=[secret] NODE_KEY=[secret]');
    expect(hidden('token: t0k3n, client_secret: s3cr3t')).toBe('token: [secret], client_secret: [secret]');
  });

  it('hides a private key block whole', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAAAAAAAEAAAAzAAAAC3NzaC1lZDI1\n-----END OPENSSH PRIVATE KEY-----';
    expect(hidden(`Key:\n${pem}\nend`)).toBe('Key:\n[secret]\nend');
  });

  it('hides a long string of letters and digits that looks like a key, a hash or a code', () => {
    expect(hidden('secret q7yJ8m3c0v+K2b1sQ0dZpYxW5tR9uE4nH6gA3fL1oPk= here')).toBe('secret [secret] here');
    expect(hidden('commit 6e8540f9a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8 broke it')).toBe('commit [secret] broke it');
  });

  it('hides email addresses', () => {
    expect(hidden('Write to ivan.petrov+hh@acme-corp.example.com or to me.')).toBe('Write to [email] or to me.');
  });

  it("hides the addresses of the company's repositories and its other places, with or without a sign-in in them", () => {
    expect(hidden('git clone https://ivan:p4ss@git.acme.example/shop/backend.git failed')).toBe('git clone [address] failed');
    expect(hidden('remote git@github.com:acme/private-shop.git refused')).toBe('remote [address] refused');
    expect(hidden('see https://github.com/acme/private-shop/pull/12.')).toBe('see [address].');
    expect(hidden('ssh://git@gitlab.acme.example:2222/group/repo.git')).toBe('[address]');
    expect(hidden('Our link https://acme.hornhoof.org/tasks/3 is slow')).toBe('Our link [address] is slow');
  });

  it("keeps the addresses of Hornhoof's own pages", () => {
    const own = 'https://github.com/invariant0x/hornhoof/issues/12 and https://hornhoof.org/guide';
    expect(hidden(own)).toBe(own);
    expect(hidden('https://user:pw@github.com/invariant0x/hornhoof')).toBe('[address]');
  });

  it('hides paths in a home folder, on Linux, macOS and Windows', () => {
    expect(hidden('opened /home/ivan/work/shop/.env at once')).toBe('opened [path] at once');
    expect(hidden('in /Users/Ivan/Library/Logs/hornhoof.log')).toBe('in [path]');
    expect(hidden('C:\\Users\\Ivan\\AppData\\Roaming\\x.json is missing')).toBe('[path] is missing');
    expect(hidden('read ~/projects/acme/notes.md')).toBe('read [path]');
    expect(hidden('the key in /root/.ssh/id_ed25519')).toBe('the key in [path]');
    expect(hidden('the folder /data/home/agents/x/hornhoof')).toBe('the folder [path]');
  });

  it('leaves plain words, versions, codes and the paths of the program alone', () => {
    const plain = 'The terminal froze for 5 minutes on a linux x64 node with Hornhoof 0.18.11, code relay_unreachable, in apps/server/src/config.ts.';
    expect(cleanText(plain)).toEqual({ text: plain, hidden: { secret: 0, email: 0, address: 0, path: 0 } });
  });

  it('counts what it hid, and hides nothing more when it cleans its own result', () => {
    const once = cleanText('Mail ivan@acme.example, key ghp_0123456789abcdefghijABCDEFGHIJ012345, repo git@github.com:acme/x.git, file /home/ivan/x, token=abc');
    expect(once.hidden).toEqual({ secret: 2, email: 1, address: 1, path: 1 });
    expect(once.text).toBe('Mail [email], key [secret], repo [address], file [path], token=[secret]');
    expect(cleanText(once.text)).toEqual({ text: once.text, hidden: { secret: 0, email: 0, address: 0, path: 0 } });
  });
});
