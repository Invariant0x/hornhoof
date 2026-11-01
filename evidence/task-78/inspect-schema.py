#!/usr/bin/env python3
"""Decode selected public protobuf descriptors as data, without executing the artifact."""
from datetime import datetime, timezone
import hashlib
import json
import mmap
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent
BINARY = BASE / 'cache/antigravity-1.4.12-linux-arm64'


def varint(buf, pos):
    value = 0
    for shift in range(0, 70, 7):
        byte = buf[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError('long varint')


def field(buf, pos):
    tag, pos = varint(buf, pos)
    number, wire = tag >> 3, tag & 7
    assert number > 0
    if wire == 0:
        value, pos = varint(buf, pos)
    elif wire == 2:
        length, pos = varint(buf, pos)
        value, pos = bytes(buf[pos:pos + length]), pos + length
    elif wire in (1, 5):
        length = 8 if wire == 1 else 4
        value, pos = bytes(buf[pos:pos + length]), pos + length
    else:
        raise ValueError(f'wire {wire}')
    assert pos <= len(buf)
    return number, value, pos


def fields(buf):
    pos, result = 0, []
    while pos < len(buf):
        n, v, pos = field(buf, pos)
        result.append((n, v))
    return result


def text_value(items, key):
    return next((v.decode('utf8') for n, v in items if n == key), None)


def message(raw):
    parts = fields(raw)
    result = dict(name=text_value(parts, 1), fields=[])
    for n, v in parts:
        if n == 2:
            f = fields(v)
            result['fields'].append(dict(name=text_value(f, 1), number=next(v for n, v in f if n == 3),
                                         type=next(v for n, v in f if n == 5), typeName=text_value(f, 6),
                                         jsonName=text_value(f, 10)))
    return result


started = datetime.now(timezone.utc).isoformat()
selected = []
with BINARY.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
    for path, wanted in [
        ('third_party/jetski/hooks_pb/hooks.proto', {'HookArgsCommon', 'HookArgs', 'PreInvocationHookArgs', 'PreInvocationHookResult', 'PostInvocationHookResult'}),
        ('third_party/jetski/language_server_pb/language_server.proto', {'GetTokenBaseRequest', 'GetTokenBaseResponse'}),
        ('third_party/jetski/cortex_pb/cortex.proto', {'TokenBreakdown', 'TokenGroup', 'TopLevelTokenGroup'}),
    ]:
        name = path.encode()
        assert len(name) < 128
        prefix = bytes([10, len(name)]) + name + bytes([18])
        start = data.find(prefix)
        assert start >= 0 and data.find(prefix, start + 1) == -1
        pos, entries, syntax = start, [], None
        while syntax is None:
            n, v, pos = field(data, pos)
            entries.append((n, v))
            if n == 12:
                syntax = v.decode()
            assert pos - start < 4_000_000
        assert syntax == 'proto3' and text_value(entries, 1) == path
        messages = [message(v) for n, v in entries if n == 4]
        found = [m for m in messages if m['name'] in wanted]
        assert {m['name'] for m in found} == wanted
        enums = []
        if 'hooks_pb' in path:
            for n, v in entries:
                if n != 5:
                    continue
                e = fields(v)
                values = []
                for k, raw in e:
                    if k == 2:
                        pairs = fields(raw)
                        values.append(dict(name=text_value(pairs, 1), number=next(v for n, v in pairs if n == 2)))
                enums.append(dict(name=text_value(e, 1), values=values))
        selected.append(dict(path=path, package=text_value(entries, 2), offset=start, bytes=pos - start,
                             sha256=hashlib.sha256(data[start:pos]).hexdigest(), syntax=syntax,
                             messages=found, enums=enums))

result = dict(task=78, startedAt=started, endedAt=datetime.now(timezone.utc).isoformat(), pid=os.getpid(),
              method='Read FileDescriptorProto wire fields through syntax=proto3; no native execution',
              selected=selected, limitation='Embedded schemas establish fields, not supported entrypoints or runtime enforcement')
(BASE / 'schema-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
for item in selected:
    print('DESCRIPTOR', item['path'], 'OFFSET', item['offset'], 'BYTES', item['bytes'], 'SHA256', item['sha256'])
    for m in item['messages']:
        print('MESSAGE', m['name'], [(f['number'], f['name'], f['typeName'] or f['type']) for f in m['fields']])
    for e in item['enums']:
        print('ENUM', e['name'], e['values'])
print('STATIC_ONLY:NO_BINARY_EXECUTION')
