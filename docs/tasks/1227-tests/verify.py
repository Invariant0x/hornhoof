"""Verify saved Security evidence; do not rerun product checks."""

import hashlib
import json
import re
import subprocess
import tarfile
from pathlib import Path


def main() -> None:
    folder = Path(__file__).resolve().parent
    repo = folder.parents[2]
    audit = json.loads((folder / "security-audit.json").read_bytes())
    reviewed = "ee4a49d54a882b1c8e9070689fd6ace447e9ab2a"
    assert audit["candidate"] == reviewed
    with tarfile.open(folder / "review-1227-evidence.tar.gz") as archive:
        files = {}
        for member in archive.getmembers():
            if member.isfile():
                stream = archive.extractfile(member)
                assert stream is not None
                files[member.name.removeprefix("review-1227/")] = stream.read()
    manifest = json.loads(files["manifest.json"])
    for name, digest in manifest.items():
        assert hashlib.sha256(files[name]).hexdigest() == digest, name
    assert files["review-audit.json"] == (folder / "review-audit.json").read_bytes()
    review = json.loads(files["review-audit.json"])
    versions = {
        "prior": review["prior"],
        "turn31": review["base"],
        "candidate": reviewed,
    }
    for item in review["objects"]:
        for label, commit in versions.items():
            result = subprocess.run(
                ["git", "rev-parse", "--verify", f"{commit}:{item['path']}"],
                cwd=repo, capture_output=True, text=True, check=False,
            )
            actual = result.stdout.strip() if result.returncode == 0 else None
            assert actual == item[label], (item["path"], label)
    for check in review["checks"]:
        raw = files[check["log"]]
        assert hashlib.sha256(raw).hexdigest() == check["sha256"]
        text = raw.decode()
        assert f"# commit: {reviewed} (task-1227)" in text
        assert f"# command: {check['command']}" in text
        assert re.search(r"^# exit code: 0$", text, re.MULTILINE)
        assert re.search(r"empty = clean\):\n# started:", text)
        if check["passed"] is not None:
            pattern = rf"^\s*Tests\s+{check['passed']} passed"
            assert re.search(pattern, text, re.MULTILINE)
    assert len(manifest) == 20
    assert len(review["objects"]) == 42
    assert len(review["checks"]) == 10
    assert sum(check["passed"] or 0 for check in review["checks"]) == 51
    merge = "226fb7272566965115e443277f00af4623ca9450"
    parents = subprocess.check_output(
        ["git", "show", "-s", "--format=%P", merge], cwd=repo, text=True,
    ).split()
    assert parents == review["mergeParents"]
    remerge = subprocess.check_output(
        ["git", "show", "--remerge-diff", "--format=", merge],
        cwd=repo, text=True,
    )
    conflicts = re.findall(r"^remerge CONFLICT .*Merge conflict in (.+)$", remerge, re.MULTILINE)
    assert set(conflicts) == set(review["conflicts"])
    journal = subprocess.check_output(
        ["git", "show", f"{review['base']}:apps/server/drizzle/meta/_journal.json"],
        cwd=repo, text=True,
    )
    assert json.loads(journal)["entries"][-1]["tag"] == "0136_outbound_contact_log"
    for name in ["red-final-events.log", "red-final-orchestrator-sql-secrets.log"]:
        text = files[name].decode()
        assert f"# commit: {merge} (task-1227)" in text
        assert "# exit code: 1" in text and "AssertionError" in text
    print("PASS: 20 archive hashes, 126 Git objects, 10 exact-version receipts, 51 passed tests, merge parents and conflicts, two behavioral REDs")
    print("LIMIT: T5 NOT_PASS with the heads accepted DB exception; native review NOT_RUN; no new product check run")


if __name__ == "__main__":
    main()
