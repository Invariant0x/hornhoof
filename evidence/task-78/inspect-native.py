#!/usr/bin/env python3
"""Record selected ARM64 function bytes/direct BL references, not execute or emulate them."""
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
PIN = '946f014d9bd4352f09f4e88377f7957264d663437de6ad239a31247a6fc9a352'
started = datetime.now(timezone.utc).isoformat()
assert BINARY.stat().st_mode & 0o111 == 0
with BINARY.open('rb') as source:
    assert hashlib.file_digest(source, 'sha256').hexdigest() == PIN
tables = json.loads((BASE / 'cache/function-index.json').read_text())
rows = tables[0]['functions']
assert tables[0]['textBase'] == 0  # entry/end remain relative in the metadata index
sections = json.loads((BASE / 'elf-sections.json').read_text())
module = next(s for s in sections if s['name'] == '.go.module')
rela = next(s for s in sections if s['name'] == '.rela.dyn')
text = next(s for s in sections if s['name'] == '.text')
targets = [
    'tokenizer.(*EstimateTokenCounter).GetTokenCount', 'tokenizer.createDefaultTokenCounter',
    'tokenizer.GetDefaultTokenCounter', 'tokens.ComputeCustomizationBreakdown', 'tokens.ComputeTokenBase',
    'mixins.NewUserRulesSection', 'mixins.(*UserRulesSection).Content', 'mixins.(*UserRulesSection).formatMemoriesAsPrompt',
    'mixins.(*UserRulesSection).formatDemotedMemoriesAsPrompt',
    'customizations.(*Manager).getRules', 'customizations.(*Manager).parseRuleFile',
    'customizations.(*Manager).resolveFileIncludes', 'customizations.(*Manager).resolveFileIncludes.func1',
    'customizations.sortRules', 'customizations.sortRules.func1',
    'customizations.(*Manager).computeTruncatedCustomizations',
    'customizations.TruncateFromBreakdown', 'customizations.TruncateFromBreakdown.func1',
    'hooks.NewPreInvocationHook.func1', 'hooks.(*HookMixinWrapper).PreInvocationHooks',
    'hookcaller.CallPreInvocationHook', 'jsonhook.executeCommandModeHook',
    'jsonhook.dropUnsupportedFields', 'jsonhook.(*Caller).CallHook', 'jsonhook.marshalHookArgs',
    'language_server.(*Server).GetTokenBase',
]
selected = []
with BINARY.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
    relocations = {}
    for p in range(rela['offset'], rela['offset'] + rela['bytes'], 24):
        target, info, addend = struct.unpack_from('<QQq', data, p)
        if module['vaddr'] <= target < module['vaddr'] + module['bytes']:
            assert info & 0xffffffff == 1027  # R_AARCH64_RELATIVE
            relocations[target - module['vaddr']] = dict(offset=p, addend=addend)
    assert relocations[0]['addend'] == tables[0]['headerOffset']
    text_base = relocations[160]['addend']
    text_end = relocations[168]['addend']
    assert text_end - text_base == rows[-1]['end']
    assert text['vaddr'] <= text_base < text_end <= text['vaddr'] + text['bytes']
    file_base = text['offset'] + text_base - text['vaddr']
    starts = [f['entry'] for f in rows]
    for suffix in targets:
        matches = [f for f in rows if f['name'].endswith(suffix)]
        assert len(matches) == 1, suffix
        f = matches[0]
        begin = file_base + f['entry']
        end = file_base + f['end']
        calls, indirect = [], []
        for p in range(begin, end - 3, 4):
            w = struct.unpack_from('<I', data, p)[0]
            if w & 0xfc000000 == 0x94000000:
                imm = w & 0x3ffffff
                if imm & 0x2000000:
                    imm -= 0x4000000
                target = p - file_base + imm * 4
                i = bisect.bisect_right(starts, target) - 1
                callee = rows[i]['name'] if i >= 0 and rows[i]['entry'] == target else None
                calls.append(dict(fileOffset=p, word=f'{w:08x}', targetRelative=target, callee=callee))
            elif w & 0xfffffc1f == 0xd63f0000:
                indirect.append(dict(fileOffset=p, register=(w >> 5) & 31, word=f'{w:08x}'))
        selected.append(dict(name=f['name'], nameByteOffset=f['nameByteOffset'], fileOffset=begin,
                             bytes=end - begin, sha256=hashlib.sha256(data[begin:end]).hexdigest(),
                             hex=data[begin:end].hex(), directCalls=calls, indirectCalls=indirect))
    schema_symbols = [dict(name=f['name'], offset=f['nameByteOffset']) for f in rows
                      if f['name'].startswith('google3/third_party/jetski/cortex/utils/utils.ToJSONSchemaString[')
                      and 'termination_behavior' in f['name'] and 'stop the turn before calling the model' in f['name']]
    assert len(schema_symbols) == 1
    literals = []
    for needle in [b'"rules-token-budget": 20000,', b'"customization-token-budget": 20000,']:
        positions = [m.start() for m in re.finditer(re.escape(needle), data)]
        assert len(positions) == 1
        literals.append(dict(offset=positions[0], value=needle.decode()))
result = dict(task=78, startedAt=started, endedAt=datetime.now(timezone.utc).isoformat(), pid=os.getpid(),
              binarySha256=PIN, textBase=text_base, textEnd=text_end, textFileBase=file_base,
              moduleRelocations={k: relocations[k] for k in [0, 160, 168]},
              method='Primary Go metadata, moduledata RELATIVE relocations, direct AArch64 BL imm26 only',
              functions=selected, schemaSymbols=schema_symbols, configLiterals=literals,
              limitation='Direct references and bytes only; no control-flow completeness, indirect-call resolution or execution proof')
(BASE / 'native-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
print('PIN_MATCH', PIN, 'PRIMARY_GO_TEXT', text_base, text_end)
for f in selected:
    calls = sorted({x['callee'] for x in f['directCalls'] if x['callee']})
    local = [x for x in calls if 'jetski/' in x]
    print('FUNCTION', f['name'], 'OFFSET', f['fileOffset'], 'BYTES', f['bytes'],
          'DIRECT_CALLS', len(f['directCalls']), 'INDIRECT_CALLS', len(f['indirectCalls']))
    print('JETSKI_DIRECT', local)
print('PRE_INVOCATION_JSON_SCHEMA', schema_symbols)
print('CONFIG_LITERALS', literals)
print('STATIC_ONLY:NO_BINARY_EXECUTION; direct calls do not prove branch or runtime semantics')
