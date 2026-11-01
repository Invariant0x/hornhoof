#!/usr/bin/env python3
"""Read ELF section headers and candidate Go pc headers, never execute the input."""
import json
import mmap
from pathlib import Path
import re
import struct

BASE = Path(__file__).resolve().parent
with (BASE / 'cache/antigravity-1.4.12-linux-arm64').open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
    assert data[:6] == b'\x7fELF\x02\x01'
    assert struct.unpack_from('<H', data, 18)[0] == 183
    table = struct.unpack_from('<Q', data, 40)[0]
    entry_size, count, name_index = struct.unpack_from('<HHH', data, 58)
    assert entry_size == 64
    raw = [struct.unpack_from('<IIQQQQIIQQ', data, table + i * 64) for i in range(count)]
    names = raw[name_index]
    sections = []
    for name, typ, flags, vaddr, offset, size, link, info, align, ent in raw:
        start = names[4] + name
        stop = data.find(b'\0', start, names[4] + names[5])
        assert stop >= start
        sections.append(dict(name=data[start:stop].decode(), type=typ, vaddr=vaddr, offset=offset, bytes=size, entrySize=ent))
    headers = []
    for hit in re.finditer(b'\xf1\xff\xff\xff\x00\x00[\x01\x02\x04]\x08', data):
        pos = hit.start()
        words = struct.unpack_from('<8Q', data, pos + 8)
        nfunc, nfiles, text, fn, cu, files, pct, pcln = words
        if 100 < nfunc < 1_000_000 and 0 < nfiles < nfunc and fn == 72 and fn < cu < files < pct < pcln and pos + pcln + (nfunc + 1) * 8 < len(data):
            headers.append((pos, words))
    assert len(headers) == 2
(BASE / 'elf-sections.json').write_text(json.dumps(sections, indent=2) + '\n')
(BASE / 'pcln-headers.json').write_text(json.dumps(headers, indent=2) + '\n')
print('ELF_MACHINE_AARCH64=183', 'SECTIONS', len(sections), 'GO_HEADERS', [(p, words[0]) for p, words in headers])
print('STATIC_ONLY:NO_BINARY_EXECUTION')
