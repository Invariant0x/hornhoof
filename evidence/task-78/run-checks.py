#!/usr/bin/env python3
"""Run only owned read-only Python inspectors and git status, with complete receipts."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
commands = [[sys.executable, str(BASE / name)] for name in ['inspect-layout.py', 'inspect-pcln.py', 'inspect-schema.py', 'inspect-native.py', 'verify-evidence.py']]
for repo in ['hornhoof', 'task-78-antigravity-engine-proof']:
    commands.extend([['git', '-C', str(ROOT / repo), 'rev-parse', '--abbrev-ref', 'HEAD'],
                     ['git', '-C', str(ROOT / repo), 'rev-parse', 'HEAD'],
                     ['git', '-C', str(ROOT / repo), 'status', '--porcelain=v1']])
receipts = []
for command in commands:
    start = datetime.now(timezone.utc).isoformat()
    proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = proc.communicate(timeout=45)
    record = dict(argv=command, cwd=str(ROOT), startedAt=start, endedAt=datetime.now(timezone.utc).isoformat(),
                  pid=proc.pid, exit=proc.returncode, stdout=stdout, stderr=stderr)
    receipts.append(record)
    print('COMMAND', json.dumps(command), 'PID', proc.pid, 'UTC', start, 'EXIT', proc.returncode)
    print(stdout, end='')
    if stderr:
        print(stderr, end='')
    (BASE / 'command-receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
    if proc.returncode:
        sys.exit(proc.returncode)
print('ALL_11_READ_ONLY_COMMANDS_EXIT0; NO_NATIVE_CLI_INVOCATION')
