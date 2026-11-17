"""Audit saved task 1220 records. This does not execute product tests."""

import hashlib
import itertools
import json
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path


def main() -> None:
    folder = Path(__file__).resolve().parent
    repo = folder.parents[2]
    candidate = "b0b972aa75fbfa31a6f0b0decf500858ea68278a"
    base = "76c4b7d571aba37c5eefd12cac4eeee4945c01e5"
    archive = folder / "task-1220-checks-b0b972aa7.zip"
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert digest == "75072b731f299fb5902caeee26da17d410f1c95fa01cf52a6478edc9a3ad47fd"
    with zipfile.ZipFile(archive) as zipped:
        files = {item.filename: zipped.read(item) for item in zipped.infolist() if not item.is_dir()}

    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", *args], cwd=repo)

    manifest = json.loads(files["manifest.json"])
    assert manifest["commit"] == candidate and manifest["base"] == base
    changed = set(git("diff", "--name-only", base, candidate).decode().splitlines())
    assert changed == set(manifest["files"])
    assert len(changed) == 24
    for path, expected in manifest["files"].items():
        assert hashlib.sha256(git("show", f"{candidate}:{path}")).hexdigest() == expected, path
    assert files["candidate.patch"] == git("diff", base, candidate, "--")
    finals = json.loads(files["final-check-statuses.json"])
    assert finals["commit"] == candidate and len(finals["results"]) == 9
    for check in finals["results"]:
        assert check["exitCode"] == 0, check
        assert files[check["name"] + ".log"].decode().startswith("$ " + " ".join(check["command"]) + "\n")

    counts = {
        "server-core-green-2.log": 41,
        "callers-green.log": 124,
        "server-coverage-single.log": 10,
        "web-coverage.log": 64,
    }
    timings = []
    for log, expected in counts.items():
        text = files[log].decode()
        assert re.search(rf"^\s*Tests\s+{expected} passed \({expected}\)\s*$", text, re.MULTILINE), log
        assert not re.search(r"^\s*FAIL\s", text, re.MULTILINE), log
        current_file = None
        for line in text.splitlines():
            file_match = re.match(r"^\s*✓ (test/\S+) \((\d+) tests?\) (\d+)ms$", line)
            if file_match:
                current_file = file_match[1]
                timings.append({"log": log, "file": current_file, "kind": "reported file test duration", "ms": int(file_match[3])})
                continue
            slow = re.match(r"^\s*✓ (.+) (\d+)ms$", line)
            if slow and int(slow[2]) > 1000:
                timings.append({"log": log, "file": current_file, "kind": "test over 1 second", "name": slow[1], "ms": int(slow[2])})

    red_needles = {
        "head-red.log": "actingAgentId",
        "card-red.log": "Name: Head Hana (authority: Dana)",
        "migration-red.log": "column_default",
    }
    for log, needle in red_needles.items():
        text = files[log].decode()
        assert needle in text and "AssertionError" in text
        assert re.search(r"Tests\s+1 failed", text), log

    cases = []
    for log in ["browser-green-2.log", "browser-remaining-1.log", "browser-remaining-2.log"]:
        text = files[log].decode()
        assert not re.search(r"^\s*✘", text, re.MULTILINE), log
        for match in re.finditer(r"✓\s+\d+ \[history-(chromium|firefox|webkit)\].*employee history in (en|ru), (light|cyberpunk), at (375|1280)px", text):
            cases.append({"log": log, "browser": match[1], "locale": match[2], "theme": match[3], "width": int(match[4])})
    keys = [(c["browser"], c["locale"], c["theme"], str(c["width"])) for c in cases]
    expected_keys = set(itertools.product(["chromium", "firefox", "webkit"], ["en", "ru"], ["light", "cyberpunk"], ["375", "1280"]))
    assert len(keys) == len(set(keys)) == 24 and set(keys) == expected_keys
    assert "8 passed" in files["browser-remaining-1.log"].decode()
    assert "4 passed" in files["browser-remaining-2.log"].decode()
    assert manifest["checks"]["browser"]["parts"][0]["exitCode"] == 143
    screenshots = [name for name in files if re.match(r"browser-remaining-[12]/.*\.png$", name)]
    assert len(screenshots) == 12

    review_archive = folder / "t1220-review-logs-b0b972aa.tar.gz"
    review_digest = hashlib.sha256(review_archive.read_bytes()).hexdigest()
    assert review_digest == "7dfc9d5910aee7055e9e3ab3ddc50720e7ac76f75b4395cb78a6d7ac6ddfb1e6"
    with tarfile.open(review_archive) as tar:
        review_files = {member.name.removeprefix("./"): tar.extractfile(member).read() for member in tar.getmembers() if member.isfile()}
    review = json.loads(review_files["manifest.json"])
    assert review["commit"] == candidate and review["base"] == base
    assert len(review["runs"]) == 16
    passed_tests = {"apps/server": 0, "apps/web": 0}
    failed_runs = []
    review_timings = []
    for check in review["runs"]:
        raw = review_files[check["log"]]
        assert hashlib.sha256(raw).hexdigest() == check["sha256"], check["log"]
        text = raw.decode()
        if "vitest run" in check["command"]:
            assert "--maxWorkers=1 --no-file-parallelism" in check["command"]
            match = re.search(r"^\s*Tests\s+(\d+) passed \((\d+)\)\s*$", text, re.MULTILINE)
            if check["exit"] == 0:
                assert match and match[1] == match[2], check["log"]
                assert not re.search(r"^\s*FAIL\s", text, re.MULTILINE)
                passed_tests[check["cwd"]] += int(match[1])
            else:
                assert check["exit"] == 1 and "Test timed out in 20000ms" in text, check["log"]
                failed_runs.append(check["log"])
            duration = re.search(r"Duration\s+([\d.]+)s", text)
            slow = re.findall(r"^\s*[✓×]\s+(.+) (\d+)ms$", text, re.MULTILINE)
            review_timings.append({"log": check["log"], "exit": check["exit"], "runnerSeconds": float(duration[1]), "reportedOverOneSecond": [{"name": name, "ms": int(ms)} for name, ms in slow if int(ms) > 1000]})
        else:
            assert check["exit"] == 0 and raw == b"", check["log"]
    assert passed_tests == {"apps/server": 424, "apps/web": 64}
    assert set(failed_runs) == {"t1220-head-department-control.log", "t1220-templates-pipeline.log"}

    audit = {
        "candidate": candidate,
        "base": base,
        "archiveSha256": digest,
        "entrySha256": {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()},
        "candidateFilesMatched": len(changed),
        "exactCandidatePatchMatched": True,
        "recordedFinalCommands": finals["results"],
        "completedUniqueServerTests": 165,
        "completedCardTests": 64,
        "coverageHeadTestsOverlap": 10,
        "browserCases": cases,
        "retainedScreenshots": screenshots,
        "timings": timings,
        "review": {"archiveSha256": review_digest, "manifest": review, "passedTests": passed_tests, "failedRunsNotPass": failed_runs, "timings": review_timings},
        "limits": [
            "Final manifest binds candidate sources; earlier run/source attribution also needs producer records.",
            "First browser part exited 143 after 12 completed cases. No whole-run PASS is inferred.",
            "Only light and cyberpunk themes were exercised, not matrix and pixel.",
            "No fresh product test was executed by this verifier.",
        ],
    }
    (folder / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    print("PASS records: archive SHA256, 24 source hashes, exact candidate diff, 9 final exit records, 3 behavioral REDs, 165 server + 64 card tests, 24 unique completed browser cases, 12 retained screenshots")
    print("PASS Review records: archive SHA256, 16 log hashes, exact candidate, 424 server + 64 card tests, types and lint; 2 failed timeout runs preserved as NOT_PASS")
    print("LIMIT: record consistency does not add missing run provenance or prove a whole interrupted run passed")


if __name__ == "__main__":
    main()
