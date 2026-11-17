"""Verify the late producer records without executing their commands."""

import hashlib
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


folder = Path(__file__).resolve().parent
repo = folder.parents[2]
archive = folder / "task-1220-provenance-f33491c30.zip"
assert hashlib.sha256(archive.read_bytes()).hexdigest() == "9c89d2428bdf5c84502ec7ec1c31f6892e43c9b8f478643d1d2a60e8c9ac27d9"
with zipfile.ZipFile(archive) as zipped:
    files = {name: zipped.read(name) for name in zipped.namelist()}
with zipfile.ZipFile(folder / "task-1220-checks-b0b972aa7.zip") as zipped:
    original = {name: zipped.read(name) for name in zipped.namelist()}
p = json.loads(files["provenance.json"])
events = [json.loads(line) for line in files["tool-events.jsonl"].splitlines()]
assert len(events) == 42
by_line = {e["sourceLine"]: e for e in events}
assert len(by_line) == 42
assert p["candidate"] == "b0b972aa75fbfa31a6f0b0decf500858ea68278a"


def contains(value, target):
    if value == target:
        return True
    if isinstance(value, dict):
        return any(contains(child, target) for child in value.values())
    if isinstance(value, list):
        return any(contains(child, target) for child in value)
    return False


def receipts(event):
    found = []
    for block in event["toolOutput"]:
        for line in block["text"].splitlines():
            try:
                found.append(json.loads(line))
            except ValueError:
                pass
    return found


expected_exits = [0, 0, 143, 0, 0]
for run, expected in zip(p["runs"], expected_exits, strict=True):
    launch = by_line[run["launch"]["sourceLine"]]
    assert launch["callId"] == run["launch"]["callId"]
    literals = [json.loads(m[0]) for m in re.finditer(r'"(?:[^"\\]|\\.)*"', launch["toolInput"])]
    assert run["launch"]["shell"] in literals, run["name"]
    assert run["launch"]["cwd"] in literals
    completion = run["completion"]
    event = by_line[completion["sourceLine"]]
    assert event["callId"] == completion["callId"]
    assert contains(receipts(event), completion["receipt"]), run["name"]
    assert completion["receipt"]["exit_code"] == expected
    assert hashlib.sha256(original[run["originalLog"]]).hexdigest() == run["originalLogSha256"]

manifest = json.loads(original["manifest.json"])
candidate_files = {path: subprocess.check_output(["git", "show", f"{p['candidate']}:{path}"], cwd=repo) for path in manifest["files"]}
states = {}
for name, state in p["snapshots"].items():
    assert set(state["fileSha256"]) == set(candidate_files)
    with tempfile.TemporaryDirectory(prefix="task-1220-reconstruction-") as temp:
        root = Path(temp)
        for path, raw in candidate_files.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        if name != "browser-all-parts":
            patch = json.loads(files[name + "-from-candidate.patch.json"])["patch"]
            paths = re.findall(r"^(?:--- a/|\+\+\+ b/)(.+)$", patch, re.MULTILINE)
            assert paths and set(paths) <= set(candidate_files)
            for path in paths:
                assert ".." not in Path(path).parts and not Path(path).is_absolute()
            subprocess.run(["git", "apply", "--check"], input=patch.encode(), cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply"], input=patch.encode(), cwd=root, check=True, capture_output=True)
        changed = []
        for path, raw in candidate_files.items():
            reconstructed = (root / path).read_bytes()
            assert hashlib.sha256(reconstructed).hexdigest() == state["fileSha256"][path], (name, path)
            if reconstructed != raw:
                changed.append(path)
        assert sorted(changed) == sorted(state["differingPathsFromCandidate"])
        states[name] = changed
assert len(states["core"]) == 4 and not any(path.startswith("apps/server/") for path in states["core"])
assert len(states["callers"]) == 2 and not any(path.startswith("apps/server/") for path in states["callers"])
assert states["browser-all-parts"] == []
assert p["failedEarlierAttempt"]["completion"]["receipt"]["exit_code"] == 1
assert "NOT_RETAINED" in p["filteredCardAfterRefactor"]["terminalExitReceipt"]
assert not any(r["originalLog"] == "card-refactor.log" for r in p["runs"])
result = {"candidate": p["candidate"], "eventCount": len(events), "verifiedRunExits": expected_exits, "reconstructedStateDifferences": states, "cardRefactorTerminalExit": "NOT_RETAINED", "limit": "Source states reconstructed retrospectively from the producer's selected write records; no launch-time filesystem snapshot or new independent product execution."}
(folder / "provenance-audit.json").write_text(json.dumps(result, indent=2) + "\n")
print("PASS: archive hash, 42 source records, 5 command/cwd/exit receipts and original log hashes, 96 reconstructed file hashes; filtered card exit excluded")
print("LIMIT: reconstructed source equivalence assumes complete producer write records; first browser exit 143 is not a whole-run PASS")
