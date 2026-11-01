#!/usr/bin/env python3
"""Fetch the explicitly authorized public pinned artifact. Never install or execute it."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import struct
import tarfile
import urllib.request

BASE = Path(__file__).resolve().parent
CACHE = BASE / 'cache'
CACHE.mkdir(exist_ok=True)
URL = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.12-4768735748292608/linux-arm/cli_linux_arm64.tar.gz'
ARCHIVE_SHA512 = '7cae317fb6a02eb387982f06bfb234b366879cf9a80ad8969b571e5a55d1e37a6a5a49cd6b703c0443bb417937cf5e3b14a8c80cb26917ad79eef723a9f374c7'
BINARY_SHA256 = '946f014d9bd4352f09f4e88377f7957264d663437de6ad239a31247a6fc9a352'
def utc():
    return datetime.now(timezone.utc).isoformat()
assert platform.system() == 'Linux' and platform.machine() in ('aarch64', 'arm64')
record = dict(task=78, command='python3 task-78-evidence/fetch-artifact.py', pid=os.getpid(),
              startedAt=utc(), url=URL, artifactVersion='1.4.12', cpu=platform.machine(),
              mode='PUBLIC_PINNED_ARTIFACT_READ_ONLY_NO_INSTALL_OR_EXECUTION')
archive = CACHE / 'cli_linux_arm64.tar.gz'
digest = hashlib.sha512()
size = 0
print('FETCH_STARTED', record['startedAt'], 'PID', record['pid'], flush=True)
with urllib.request.urlopen(URL, timeout=30) as response, archive.open('wb') as out:
    while data := response.read(1024 * 1024):
        size += len(data)
        assert size <= 300 * 1024 * 1024, 'Unexpectedly large archive'
        digest.update(data)
        out.write(data)
assert digest.hexdigest() == ARCHIVE_SHA512, 'Archive digest mismatch; do not inspect/extract'
binary = CACHE / 'antigravity-1.4.12-linux-arm64'
with tarfile.open(archive, 'r:gz') as transfer:
    members = transfer.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert member.isfile() or member.isdir(), 'Non-regular archive entry rejected'
    matches = [member for member in members if member.isfile() and PurePosixPath(member.name).name == 'antigravity']
    assert len(matches) == 1
    selected = matches[0]
    assert selected.size <= 700 * 1024 * 1024
    with transfer.extractfile(selected) as source, binary.open('wb') as out:
        shutil.copyfileobj(source, out, length=1024 * 1024)
    binary.chmod(0o600)  # Static inspection only. No executable bit in the cache.
    record['archiveMembers'] = [dict(name=m.name, bytes=m.size, regular=m.isfile()) for m in members]
with binary.open('rb') as source:
    h = hashlib.file_digest(source, 'sha256').hexdigest()
assert h == BINARY_SHA256
header = binary.read_bytes()[:64]
assert header[:4] == b'\x7fELF' and header[4] == 2 and header[5] == 1
machine = struct.unpack_from('<H', header, 18)[0]
assert machine == 183, 'ELF machine must be AArch64'
record.update(archiveBytes=size, archiveSHA512=digest.hexdigest(), binaryBytes=binary.stat().st_size,
              binarySHA256=h, binaryPath=str(binary), elfMachine=machine, executableBit=False,
              binaryExecuted=False, endedAt=utc(), exit=0)
(BASE / 'artifact-identity.json').write_text(json.dumps(record, indent=2) + '\n')
print('ARCHIVE_VERIFIED', size, 'SHA512', digest.hexdigest(), flush=True)
print('BINARY_VERIFIED', binary.stat().st_size, 'SHA256', h, 'ELF_AARCH64', machine, 'MODE0600_NO_EXECUTION', flush=True)
print('FETCH_FINISHED', record['endedAt'], 'exit0', flush=True)
