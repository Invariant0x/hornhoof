"""Turn dryer's duplicate report into an explicit pass/fail check for Task 6."""
from pathlib import Path
import subprocess
import sys

repo = Path('/Users/0x/Projects/hornhoof-edge')
result = subprocess.run([str(Path.home() / '.hornhoof-quality/bin/dryer'), '--root', str(repo),
                         '--threshold', '0.8', 'relay/relay.py'],
                        cwd=repo, capture_output=True, text=True)
print(result.stdout, end='')
if result.stderr:
    print(result.stderr, end='', file=sys.stderr)
assert result.returncode == 0, 'dryer could not complete'
assert 'DUPLICATE score=' not in result.stdout, 'dryer found a pair at or above 0.8'
