"""Check the supplied review records without rerunning product checks."""

import hashlib
import json
import re
import subprocess
import tarfile
from collections import Counter
from pathlib import Path


def main() -> None:
    evidence = Path(__file__).resolve().parent
    candidate = "b1a572fd5ed0431480ff715356a7432fc9d28a7e"
    previous = "3cdc7ed41ba2203c4d21d4648386d5e0d547e42d"
    manifest_bytes = (evidence / "t1203-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["candidate"] == candidate
    logs = {}
    archives = []
    for name in ["t1203-review-checks.tar.gz", "t1203-heavy-b1a572fd.tar.gz"]:
        path = evidence / name
        payload = path.read_bytes()
        archives.append({"name": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
        with tarfile.open(path, "r:gz") as archive:
            for member in archive.getmembers():
                if member.isfile() and member.name.endswith(".log"):
                    assert member.name not in logs, member.name
                    stream = archive.extractfile(member)
                    assert stream is not None, member.name
                    logs[member.name] = stream.read()

    verified = []
    files = []
    timing_defects = []
    for run in manifest["runs"]:
        if "log" not in run:
            continue
        payload = logs[run["log"]]
        digest = hashlib.sha256(payload).hexdigest()
        assert digest == run["log_sha256"], run["log"]
        assert len(payload) == run["log_bytes"], run["log"]
        text = re.sub(r"\x1b\[[0-9;]*m", "", payload.decode())
        passed = re.search(r"^\s*Tests\s+(\d+) passed", text, re.MULTILINE)
        failed = re.search(r"^\s*Tests\s+(\d+) failed", text, re.MULTILINE)
        if run["exit"] == 0 and "vitest run" in run["command"]:
            assert passed and not failed, run["check"]
            count = re.match(r"(\d+) passed", run["result"])
            assert count and passed.group(1) == count.group(1), run["check"]
            if " -t " not in run["command"]:
                test_file = run["command"].split("vitest run ", 1)[1].split()[0]
                files.append({"cwd": run["cwd"], "test_file": test_file, "passed": int(count.group(1))})
                duration = re.search(r"^\s*Duration\s+([\d.]+)(ms|s)\b", text, re.MULTILINE)
                assert duration, run["check"]
                seconds = float(duration.group(1)) / (1000 if duration.group(2) == "ms" else 1)
                slow_cases = []
                for name, milliseconds in re.findall(r"^\s*✓ (.+?) (\d+)ms\s*$", text, re.MULTILINE):
                    if not name.startswith("test/") and int(milliseconds) >= 1000:
                        slow_cases.append({"name": name, "milliseconds": int(milliseconds)})
                if seconds >= 30 or run.get("wall_s", 0) >= 30 or slow_cases:
                    timing_defects.append({"cwd": run["cwd"], "test_file": test_file, "runner_duration_s": seconds, "external_wall_s": run.get("wall_s"), "cases_at_least_1s": slow_cases})
        if run["check"] in {"RED R1", "RED R2"}:
            assert failed and int(failed.group(1)) == (1 if run["check"] == "RED R1" else 2)
        verified.append({"check": run["check"], "log": run["log"], "bytes": len(payload), "sha256": digest, "recorded_exit": run["exit"], "tree_record": run["tree"]})

    assert len(manifest["runs"]) == 33
    assert len(verified) == 31
    assert len(files) == len({(item["cwd"], item["test_file"]) for item in files}) == 22
    assert sum(item["passed"] for item in files) == 338
    assert set(logs) == {entry["log"] for entry in verified}
    node_objects = subprocess.check_output(
        ["git", "rev-parse", f"{previous}:apps/node", f"{candidate}:apps/node"],
        cwd=evidence.parent,
        text=True,
    ).splitlines()
    assert len(node_objects) == 2 and node_objects[0] == node_objects[1]
    report = {
        "status": "PASS for archive integrity, recorded result consistency and committed node tree binding; not a new product check run",
        "candidate": candidate,
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "manifest_bytes": len(manifest_bytes),
        "provenance": manifest["how_recorded"],
        "limits": [
            "Exit codes and precommit working tree identity are the reviewers session-derived record, not independently captured execution receipts.",
            "Hashes prove the archived bytes match this later manifest; they do not prove when commands ran.",
            "Product timing budgets and unavailable native review stay separate from assertion results.",
        ],
        "archives": archives,
        "records": len(manifest["runs"]),
        "verified_log_hashes_and_sizes": len(verified),
        "recorded_exits": dict(Counter(str(run["exit"]) for run in manifest["runs"])),
        "full_named_files": len(files),
        "distinct_tests_passed": sum(item["passed"] for item in files),
        "timing_budget_status": "FAIL; recorded over-budget files and cases remain unresolved",
        "timing_defects": timing_defects,
        "node_tree_binding": {"previous": previous, "candidate": candidate, "path": "apps/node", "object": node_objects[0]},
        "files": files,
        "logs": verified,
    }
    (evidence / "verified-review-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PASS: 33 records, 31 log hashes and sizes, 22 named files, 338 passed tests, equal committed node trees")
    print("LIMIT: session-derived execution records; timing and native-review concerns remain open")


if __name__ == "__main__":
    main()
