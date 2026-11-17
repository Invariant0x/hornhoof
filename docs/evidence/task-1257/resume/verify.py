"""Verify the saved transfer receipts, migration chain and final candidate."""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


summary = json.loads((EVIDENCE / "summary.json").read_text())
passed = 0
reused = 0
for part in summary["parts"]:
    subprocess.run(["git", "merge-base", "--is-ancestor", part["commit"], "HEAD"], cwd=ROOT, check=True)
    checked = part.get("checkedCommit", part["commit"])
    if checked != part["commit"]:
        assert not git("diff", "--name-only", checked, part["commit"], "--", *part["inputPaths"]).strip()
        reused += 1
    for name in part["checks"]:
        folder = EVIDENCE / part["evidence"]
        receipt = json.loads((folder / f"{name}.json").read_text())
        assert receipt["commit"] == checked, (part["task"], name)
        assert receipt["exit"] == 0, (part["task"], name, receipt["exit"])
        assert receipt.get("gate", "PASS") == "PASS", (part["task"], name)
        assert digest(folder / receipt["log"]) == receipt["sha256"], (part["task"], name)
        passed += 1
    for reuse in part.get("reusedChecks", []):
        folder = EVIDENCE / reuse["evidence"]
        receipt = json.loads((folder / f"{reuse['name']}.json").read_text())
        assert receipt["commit"] == reuse["sourceCommit"]
        assert receipt["exit"] == 0
        assert receipt.get("gate", "PASS") == "PASS"
        assert digest(folder / receipt["log"]) == receipt["sha256"]
        assert not git("diff", "--name-only", reuse["sourceCommit"], part["commit"], "--", *reuse["inputPaths"]).strip()
        reused += 1
    if part.get("priorChecks"):
        refresh = json.loads((EVIDENCE / part["refreshEvidence"]).read_text())
        assert refresh["previousCheckedCommit"] == part["priorCommit"]
        assert refresh["finalBase"] == part["base"]
        assert refresh["commit"] == part["commit"]
        assert refresh["rebaseConflicts"] is False
        actual = git("diff", "--stat", refresh["previousCheckedBase"], refresh["finalBase"], "--", *refresh["ownedPaths"]).decode().strip()
        assert actual == refresh["baseDiffStat"] == ""
        assert not git("diff", "--name-only", part["priorCommit"], part["commit"], "--", *refresh["ownedPaths"]).strip()
        for name in part["priorChecks"]:
            folder = EVIDENCE / part["priorEvidence"]
            receipt = json.loads((folder / f"{name}.json").read_text())
            assert receipt["commit"] == part["priorCommit"]
            assert receipt["exit"] == 0 and receipt.get("gate", "PASS") == "PASS"
            assert digest(folder / receipt["log"]) == receipt["sha256"]
            passed += 1

for artifact in summary["artifacts"]:
    assert digest(EVIDENCE / artifact["path"]) == artifact["sha256"], artifact["path"]

drizzle = ROOT / "apps/server/drizzle"
entries = json.loads((drizzle / "meta/_journal.json").read_text())["entries"]
tail = [entry for entry in entries if entry["tag"][:4] in {"0141", "0142", "0143", "0144"}]
assert len(tail) == 4
for before, after in zip(tail, tail[1:]):
    previous = json.loads((drizzle / "meta" / f"{before['tag'][:4]}_snapshot.json").read_text())
    current = json.loads((drizzle / "meta" / f"{after['tag'][:4]}_snapshot.json").read_text())
    assert current["prevId"] == previous["id"]
    assert after["idx"] == before["idx"] + 1
    assert after["when"] > before["when"]

for migration in summary["migrations"]:
    original = git("show", f"{migration['source']}:apps/server/drizzle/{migration['original']}")
    assert (drizzle / migration["current"]).read_bytes() == original

assert not git("log", "origin/main..HEAD", "--grep=Co-Authored-By: Claude", "-i").strip()
assert subprocess.run(["git", "merge-base", "--is-ancestor", "3e51a8fdd", "HEAD"], cwd=ROOT).returncode == 1
assert not git("diff", "--name-only", summary["finalCodeCommit"], "HEAD", "--", "apps", "packages", "templates", "scripts", "package.json", "package-lock.json").strip()
print(f"PASS: {passed + sum(len(part.get('reusedChecks', [])) for part in summary['parts'])} passed check records, {reused} unchanged-input comparisons, {len(summary['artifacts'])} artifact hashes, three unchanged migration SQL files, consecutive metadata and final code identity")
