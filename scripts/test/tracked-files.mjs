import { execFileSync } from 'node:child_process';

/* The files of the index by path, mode and object, as a commit's tree says them, whatever a path holds. */
export function tracked(git) {
  return git(['ls-files', '--stage', '--full-name', '-z']).split('\0').filter(Boolean).map(line => {
    const [info, path] = line.split('\t'), [mode, oid] = info.split(' ');
    return { path, mode, oid };
  });
}

export const trackedIn = root => tracked(args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }));
