#!/usr/bin/env python3
"""Read Go pcln function metadata only. Never imports or executes the inspected artifact."""
import bisect
from datetime import datetime, timezone
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import struct

BASE = Path(__file__).resolve().parent
BINARY = BASE / 'cache/antigravity-1.4.12-linux-arm64'
assert BINARY.stat().st_mode & 0o111 == 0
HEADERS = json.loads((BASE / 'pcln-headers.json').read_text())
SECTIONS = json.loads((BASE / 'elf-sections.json').read_text())
started = datetime.now(timezone.utc).isoformat()
with BINARY.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
    relasec = next(s for s in SECTIONS if s['name'] == '.rela.dyn')
    wanted = {pos + 24: pos for pos, words in HEADERS}
    text_base = {}
    for i in range(relasec['offset'], relasec['offset'] + relasec['bytes'], 24):
        target, info, addend = struct.unpack_from('<QQq', data, i)
        if target in wanted:
            text_base[wanted[target]] = {'relaOffset': i, 'target': target, 'type': info & 0xffffffff, 'addend': addend}
    tables = []
    for number, (offset, words) in enumerate(HEADERS):
        nfunc, nfiles, text, fn, cu, files, pct, pcln = words
        table = offset + pcln
        base = text_base.get(offset, {}).get('addend', text)
        functions = []
        for i in range(nfunc):
            entry, func_offset = struct.unpack_from('<II', data, table + i * 8)
            end = struct.unpack_from('<I', data, table + (i + 1) * 8)[0]
            location = table + func_offset
            assert struct.unpack_from('<I', data, location)[0] == entry
            name_offset = struct.unpack_from('<i', data, location + 4)[0]
            start = offset + fn + name_offset
            stop = data.find(b'\0', start, start + 2000)
            assert stop > start
            name = data[start:stop].decode('utf8')
            assert end >= entry
            functions.append(dict(name=name, nameByteOffset=start, entry=base + entry,
                                  end=base + end, funcMetadataOffset=location))
        tables.append(dict(index=number, headerOffset=offset, count=nfunc, textBase=base,
                           relocation=text_base.get(offset), functions=functions))
    (BASE / 'cache/function-index.json').write_text(json.dumps(tables, separators=(',', ':')) + '\n')
    patterns = {
        'rules_budget': r'(?i)(rules?.*(token|budget|resolv|load|inclu)|(?:token|budget).*rules?)',
        'invocation_hooks': r'(?i)(PreInvocation|PostInvocation|Hook.*(?:Response|Output)|(?:Run|Execute).*Hooks?)',
        'export_count_commands': r'(?i)((?:cmd|command).*(?:count|export|dryrun)|(?:count|export|dryrun).*(?:cmd|command))',
    }
    selected = {}
    for label, pattern in patterns.items():
        found = [dict(table=t['index'], **f) for t in tables for f in t['functions'] if re.search(pattern, f['name'])]
        selected[label] = found
        print('SYMBOL_GROUP', label, 'COUNT', len(found))
        for row in found[:3]:
            print(row['table'], row['nameByteOffset'], row['name'])
    result = dict(task=78, startedAt=started, endedAt=datetime.now(timezone.utc).isoformat(), pid=os.getpid(),
                  method='Go1.20+ pcln metadata; entry/end are relative when textBase=0; read only',
                  formatReference='https://raw.githubusercontent.com/golang/go/go1.24.0/src/debug/gosym/pclntab.go',
                  tables=[{k: v for k, v in t.items() if k != 'functions'} for t in tables],
                  groups=selected, limitation='Names are metadata,not supported entrypoints or behavior proof; table1 is not mapped to primary executable text; inspect-native.py resolves primary moduledata')
    (BASE / 'symbol-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
    print('STATIC_ONLY:NO_BINARY_EXECUTION;no method qualified by a symbol name alone')
