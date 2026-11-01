#!/usr/bin/env python3
"""Check the frozen safe package. Does not fetch or execute Antigravity."""
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
manifest = json.loads((BASE / 'manifest.json').read_text())
assert manifest['task'] == 78
assert len({item['name'] for item in manifest['files']}) == len(manifest['files'])
for item in manifest['files']:
    name = item['name']
    assert Path(name).name == name and name != 'manifest.json'
    path = BASE / name
    assert path.is_file() and not path.is_symlink()
    raw = path.read_bytes()
    assert len(raw) == item['bytes'], name
    assert hashlib.sha256(raw).hexdigest() == item['sha256'], name
print('SAFE_PACKAGE_MATCH:', len(manifest['files']), 'files, exact bytes and SHA256')
print('NO_ARTIFACT_EXECUTION; this verifies transport integrity, not engine qualification')
