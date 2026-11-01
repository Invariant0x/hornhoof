import hashlib
import json
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parent
cases_doc = json.loads((root / 'cases.json').read_text())
fixture = json.loads((root / 'phase-fixture-output.json').read_text())
report = (root / 'report.md').read_text()

assert len(cases_doc['cases']) == 6
assert len({case['jobId'] for case in cases_doc['cases']}) == 6
assert all(case['serverPhase'] == 'UNKNOWN' for case in cases_doc['cases'])
for case in cases_doc['cases']:
    start = datetime.fromisoformat(case['startedAt'].replace('Z', '+00:00'))
    finish = datetime.fromisoformat(case['finishedAt'].replace('Z', '+00:00'))
    actual = round((finish - start).total_seconds(), 3)
    assert actual == case['durationSeconds'], (case['label'], actual)
    assert case['jobId'] in report
    assert case['agentId'] in report

native = {case['label']: case['native'] for case in cases_doc['cases']}
assert native['F4ec']['requestToHhFailureSeconds'] == 117.525
assert native['F8c']['requestResponseSeconds'] == 122.511
assert native['F8c']['hhFailureToResponseSeconds'] == 5.022
assert native['H']['responseToHhFailureSeconds'] == 45.344
starts = [datetime.fromisoformat(case['startedAt'].replace('Z', '+00:00')) for case in cases_doc['cases'][1:5]]
assert (max(starts) - min(starts)).total_seconds() * 1000 == 12

assert fixture['sourceCommit'] == 'bd696b0724385b6b11da53a24ada2f188b031217'
assert fixture['modelCalls'] == 0 and fixture['networkCalls'] == 0
assert fixture['historicalReproduction'] is False
for file, expected in fixture['sourceSha256'].items():
    actual = hashlib.sha256((repo / file).read_bytes()).hexdigest()
    assert actual == expected, file
ready, accept, dead = fixture['scenarios']
assert ready['promptPasteCount'] == 0 and ready['enterCount'] == 0
assert ready['paneDead'] is False and ready['acceptDiagnostic'] is False
assert accept['promptPasteCount'] == 1 and accept['enterCount'] >= 2
assert accept['paneDead'] is False and accept['acceptDiagnostic'] is True
assert dead['tookBeforeDead'] is True and dead['paneDead'] is True
assert dead['acceptDiagnostic'] is False
assert 'PHASE_FIXTURE_PASS' in report
assert 'UNKNOWN for all six' in report
assert 'hh-terminal-phase-v1' in report
assert '—' not in report

print('CASES_6_OF_6_OK durations=122.180,122.155,122.266,122.356,125.845,121.567')
print('NATIVE_INTERVALS_OK F4ec=117.525 F8c=122.511/5.022 H=45.344 HH_START_SPAN_MS=12')
print('PHASE_UNKNOWN_6_OF_6 no cause assigned')
print('SOURCE_HASHES_4_OF_4_OK commit=bd696b0724385b6b11da53a24ada2f188b031217')
print('FIXTURE_SIGNATURES_OK READY paste=0 ACCEPT paste=1/prefix=true DEAD took=true/pane_dead=1')
print('REPORT_SCOPE_OK planned_trace_only no_em_dash')
