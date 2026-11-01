#!/usr/bin/env python3
"""Check saved static findings against the pinned bytes. This is not an engine qualification."""
import hashlib
import json
import mmap
from pathlib import Path
import struct

BASE = Path(__file__).resolve().parent
BINARY = BASE / 'cache/antigravity-1.4.12-linux-arm64'


def load(name):
    return json.loads((BASE / name).read_text())


def sha(path, algorithm):
    with path.open('rb') as source:
        return hashlib.file_digest(source, algorithm).hexdigest()


identity = load('artifact-identity.json')
assert sha(BINARY, 'sha256') == identity['binarySHA256'] == '946f014d9bd4352f09f4e88377f7957264d663437de6ad239a31247a6fc9a352'
assert sha(BASE / 'cache/cli_linux_arm64.tar.gz', 'sha512') == identity['archiveSHA512'] == '7cae317fb6a02eb387982f06bfb234b366879cf9a80ad8969b571e5a55d1e37a6a5a49cd6b703c0443bb417937cf5e3b14a8c80cb26917ad79eef723a9f374c7'
assert not BINARY.stat().st_mode & 0o111
print('CHECK 1 artifact: archive SHA512 + binary SHA256 match; executable bits absent')
schema = load('schema-evidence.json')
messages = {m['name']: m for file in schema['selected'] for m in file['messages']}


def names(message):
    return {f['name'] for f in messages[message]['fields']}


assert names('PreInvocationHookArgs') == {'invocation_num', 'initial_num_steps'}
assert names('PreInvocationHookResult') == {'inject_steps', 'termination_behavior'}
assert names('HookArgsCommon') == {'conversation_id', 'workspace_paths', 'transcript_path', 'artifact_directory_path', 'execution_id', 'model_name', 'is_battle_mode', 'last_user_input', 'agent_name', 'parent_conversation_id', 'caller_context', 'root_conversation_id'}
assert names('GetTokenBaseRequest') == {'cascade_config', 'workspace_uris', 'active_profile'}
assert names('TokenBreakdown') == {'groups', 'total_tokens'}
assert names('TokenGroup') == {'name', 'children', 'num_tokens'}
assert names('TopLevelTokenGroup') == {'name', 'type', 'source', 'num_tokens', 'children'}
assert next(f for f in messages['TopLevelTokenGroup']['fields'] if f['name'] == 'source')['type'] == 14
assert names('GetTokenBaseResponse') == {'customization_token_base', 'remaining_budget', 'customization_budget', 'truncated_customization_token_base', 'rules_budget', 'remaining_rules_budget', 'token_base', 'max_token_base'}
print('CHECK 2 schemas: exact selected fields match; source is enum; no defined raw-request/candidate-digest/invocation-proof field')
native = load('native-evidence.json')
with BINARY.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
    for descriptor in schema['selected']:
        start = descriptor['offset']
        assert hashlib.sha256(data[start:start + descriptor['bytes']]).hexdigest() == descriptor['sha256']
    for f in native['functions']:
        start = f['fileOffset']
        raw = data[start:start + f['bytes']]
        assert raw.hex() == f['hex'] and hashlib.sha256(raw).hexdigest() == f['sha256']
        for ref in f['directCalls'] + f['indirectCalls']:
            assert struct.unpack_from('<I', data, ref['fileOffset'])[0] == int(ref['word'], 16)
    for symbol in native['schemaSymbols']:
        start = symbol['offset']
        raw = symbol['name'].encode()
        assert data[start:start + len(raw)] == raw
    for literal in native['configLiterals']:
        start = literal['offset']
        assert data[start:start + len(literal['value'])] == literal['value'].encode()
    assert struct.unpack_from('<I', data, 131633604)[0] == 0xb40005e1  # CBZ X1, success
    assert struct.unpack_from('<I', data, 131633788)[0] == 0x17ffffbd  # B to loop increment
    assert struct.unpack_from('<I', data, 131633544)[0] == 0x54000dcd  # B.LE to nil return
    assert struct.unpack_from('<3I', data, 131633984) == (0xaa1f03e0, 0xaa1f03e1, 0xa97ffbfd)
print('CHECK 3 native bytes: 3 descriptors +', len(native['functions']), 'selected functions + schema/config literals match pinned artifact')


def calls(suffix):
    return [x['callee'] or '' for f in native['functions'] if f['name'].endswith(suffix) for x in f['directCalls']]


assert any(x.endswith('tokenizer.GetDefaultTokenCounter') for x in calls('tokens.ComputeCustomizationBreakdown'))
assert any(x.endswith('customizations.(*Manager).resolveFileIncludes') for x in calls('customizations.(*Manager).parseRuleFile'))
assert any(x.endswith('go_utils.Truncate') for x in calls('customizations.(*Manager).parseRuleFile'))
assert any(x.endswith('customizations.sortRules') for x in calls('customizations.(*Manager).getRules'))
assert any(x.endswith('customizations.TruncateFromBreakdown') for x in calls('language_server.(*Server).GetTokenBase'))
assert any(x.endswith('hookcaller.CallPreInvocationHook') for x in calls('hooks.NewPreInvocationHook.func1'))
assert any(x.endswith('log.ErrorContextf') for x in calls('hooks.NewPreInvocationHook.func1'))
print('CHECK 4 direct references: resolver/includes/truncation/default-counter/PreInvocation error-log path present')
branch = load('branch-proof.json')
with BINARY.open('rb') as source:
    for check in branch['words']:
        source.seek(check['fileOffset'])
        word = struct.unpack('<I', source.read(4))[0]
        assert word == int(check['word'], 16)
        if check['targetFileOffset'] is None:
            continue
        conditional = word & 0xff000010 == 0x54000000 or word & 0x7e000000 == 0x34000000
        bits = 19 if conditional else 26
        immediate = (word >> 5) & 0x7ffff if conditional else word & 0x3ffffff
        if immediate & (1 << (bits - 1)):
            immediate -= 1 << bits
        assert check['fileOffset'] + immediate * 4 == check['targetFileOffset']
finding = load('findings.json')
assert [finding[key]['status'] for key in ['G1', 'G2', 'G3']] == ['SOURCE_ONLY', 'UNAVAILABLE', 'SOURCE_ONLY']
assert finding['qualifiedProfile'] is None and finding['nativeCliExecutions'] == finding['modelCalls'] == 0
assert finding['boundary19999_20000_20001'] == 'NOT_RUN'
print('CHECK 5 control flow:', len(branch['words']), 'words/targets match; findings issue no qualified profile')
print('BOUNDARY_19999_20000_20001=NOT_RUN; NATIVE_ENGINE_PROFILE=UNQUALIFIED; ANTIGRAVITY_EXECUTIONS=0')
print('PASS_STATIC_EVIDENCE_ONLY; G0/G1/G2/G3 + 17 engine acceptance cases + account remain open')
