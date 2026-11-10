"""Fails if a function this change touched scores CRAP 10 or more. Old functions it did not touch are not its business.

Usage: crap-changed.py <repo> <base> <file>... , run with crapper's own Python, after crapper wrote .metrics/crap.edn.
"""

import re
import subprocess
import sys
from pathlib import Path

from crapper.discover import language_of
from crapper.languages import functions_in_file

ENTRY = re.compile(r':name "(?P<name>[^"]*)", :namespace "(?P<namespace>[^"]*)", :complexity \d+, :coverage [^,]*, :crap (?P<crap>[0-9.]+|nil)')
LIMIT = 10


def scores(repo: Path) -> dict[tuple[str, str], float]:
    text = (repo / '.metrics/crap.edn').read_text()
    return {(m['namespace'], m['name']): float(m['crap'])
            for m in ENTRY.finditer(text) if m['crap'] != 'nil'}


def changed_lines(repo: Path, base: str, file: str) -> set[int]:
    script = Path(__file__).parent / 'changed-lines.sh'
    out = subprocess.run(['sh', str(script), str(repo), base, file], capture_output=True, text=True, check=True).stdout
    return {int(n) for n in out.strip().split(',') if n}


def main(repo_arg: str, base: str, files: list[str]) -> int:
    repo = Path(repo_arg).resolve()
    known = scores(repo)
    worst = 0.0
    failed = False
    for file in files:
        touched = changed_lines(repo, base, file)
        source = (repo / file).read_text(encoding='utf-8', errors='replace')
        for fn in functions_in_file(language_of(repo / file), source, file, str(repo)):
            if not touched.intersection(range(fn.start_line, fn.end_line + 1)):
                continue
            crap = known.get((fn.namespace, fn.name))
            if crap is None:
                continue
            worst = max(worst, crap)
            if crap >= LIMIT:
                failed = True
                print(f'OVER {LIMIT}: {file}:{fn.start_line} {fn.name} CRAP {crap}')
    print(f'worst changed CRAP: {worst}')
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1], sys.argv[2], sys.argv[3:]))
