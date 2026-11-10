#!/usr/bin/env python3
"""Save and compare status, full diff and publishable file hashes around read-only reviews."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
repo, prefix, mode = sys.argv[1:]
prefix = Path(prefix)
status = subprocess.check_output(['git', 'status', '--short'], cwd=repo)
diff = subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=repo)
names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=repo)
hashes = {n.decode(): hashlib.sha256((Path(repo) / n.decode()).read_bytes()).hexdigest()
          for n in names.split(b"\0") if n and (Path(repo) / n.decode()).is_file()}
values = {'status': status, 'diff': diff, 'hashes.json': json.dumps(hashes, sort_keys=True, indent=2).encode()}
if mode == 'save':
    for suffix, content in values.items():
        Path(str(prefix) + '.' + suffix).write_bytes(content)
    print('Saved review snapshot:', prefix)
else:
    changed = []
    for suffix, content in values.items():
        Path(str(prefix) + '.after.' + suffix).write_bytes(content)
        if Path(str(prefix) + '.' + suffix).read_bytes() != content:
            changed.append(suffix)
    print('Review snapshot unchanged' if not changed else 'REVIEW MUTATION: ' + ', '.join(changed))
    sys.exit(bool(changed))
