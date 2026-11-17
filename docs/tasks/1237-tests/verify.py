"""Verify the saved exact-candidate receipts; do not rerun product checks."""

import hashlib
import json
import re
import subprocess
from pathlib import Path


folder = Path(__file__).resolve().parent
repo = folder.parents[2]
manifest = json.loads((folder / "manifest.json").read_text())
candidate, base = manifest["candidate"], manifest["base"]
assert candidate == "5fccde4cc1fd576f7ed7ae29b2949f62054f5fac"
assert base == "11aa5777c4a5f74a550c0e53570ec35ebae39f53"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=repo)


assert git("show", "-s", "--format=%P", candidate).decode().strip() == base
assert set(git("diff", "--name-only", base, candidate).decode().splitlines()) == set(manifest["sources"])
assert len(manifest["sources"]) == 2 and len(manifest["records"]) == 13
for path, digest in manifest["sources"].items():
    assert hashlib.sha256(git("show", f"{candidate}:{path}")).hexdigest() == digest
for name, digest in manifest["records"].items():
    assert hashlib.sha256((folder / "author" / name).read_bytes()).hexdigest() == digest
assert (folder / "author/fix-src.patch").read_bytes() == git("diff", base, candidate, "--", "apps/server/src/db/agent-sql.ts")
checks = {
    "final-server-orchestrator-sql-agent-changes.log": 1,
    "final-server-orchestrator-sql-secrets.log": 1,
    "final-server-head-department-control.log": 7,
    "final-server-department-owner-control.log": 11,
    "final-tsc-server-tests.log": None,
    "final-eslint-touched.log": None,
}
results = []
for name, count in checks.items():
    text = (folder / "author" / name).read_text()
    assert f"# commit: {candidate} (task-1237)" in text
    assert "# env: NODE_OPTIONS=--max-old-space-size=4096" in text
    assert "empty = clean):\n# started:" in text
    assert re.search(r"^# exit code: 0$", text, re.MULTILINE)
    command = re.search(r"^# command: (.+)$", text, re.MULTILINE)[1]
    cwd = re.search(r"^# dir: (.+)$", text, re.MULTILINE)[1]
    timing = None
    slow = []
    if count is not None:
        assert "--maxWorkers=1" in command
        assert re.search(rf"^\s*Tests\s+{count} passed \({count}\)\s*$", text, re.MULTILINE)
        assert not re.search(r"^\s*FAIL\s", text, re.MULTILINE)
        timing = float(re.search(r"Duration\s+([\d.]+)s", text)[1])
        slow = [{"name": m[1], "ms": int(m[2])} for m in re.finditer(r"^\s+✓ (.+) (\d+)ms$", text, re.MULTILINE) if int(m[2]) > 1000 and not m[1].startswith("test/")]
    results.append({"log": name, "command": command, "cwd": cwd, "exit": 0, "passed": count, "runnerSeconds": timing, "overOneSecond": slow})
red = (folder / "author/red-final-orchestrator-sql-agent-changes.log").read_text()
assert f"# commit: {base} (task-1237)" in red
assert "#    ?? test/orchestrator-sql-agent-changes.test.ts" in red
assert "AssertionError: promise resolved" in red and '"affectedRows": 1' in red
assert re.search(r"^# exit code: 1$", red, re.MULTILINE)
assert sum(check["passed"] or 0 for check in results) == 20
(folder / "audit.json").write_text(json.dumps({"candidate": candidate, "base": base, "checks": results, "redExit": 1, "productRerun": False}, indent=2) + "\n")
print("PASS: 13 record hashes, 2 candidate source hashes, parent and source patch, 6 exact-version receipts, 20 passed tests and behavioral RED")
print("LIMIT: T5 not PASS; existing local author executions reused; no live PostgreSQL or release-wide execution")
