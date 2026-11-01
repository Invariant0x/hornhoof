import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = "b8f2e7aa-1fb2-447e-9312-7dc1e12108a6"
TARGET = "100edb09-da27-4868-9646-5c0118b9934e"
RELATIVE = "task-43-evidence/review-transfer-r1/task43-review-transfer-r1.tgz"
BASENAME = "task43-review-transfer-r1.tgz"
SIZE = 2012762
DATA = bytes(range(251)) * (SIZE // 251) + bytes(range(SIZE % 251))
SHA256 = hashlib.sha256(DATA).hexdigest()
HELPER = Path(__file__).resolve().parents[1] / "task43-file.py"


class HelperProcess:
    def __init__(self, root):
        self.root = Path(root)
        self.root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)

        def inherit_root():
            if self.root_fd != 3:
                os.dup2(self.root_fd, 3)

        self.process = subprocess.Popen(
            ["/usr/bin/python3", "-I", str(HELPER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(self.root_fd,),
            preexec_fn=inherit_root,
        )
        os.close(self.root_fd)

    def call(self, **request):
        payload = json.dumps(request, separators=(",", ":")).encode()
        self.assert_bounded(payload)
        self.process.stdin.write(payload + b"\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline(49153)
        if not line:
            raise AssertionError(f"helper exited with {self.process.poll()}: {self.process.stderr.read(1024)!r}")
        self.assert_bounded(line.rstrip(b"\n"))
        return json.loads(line)

    @staticmethod
    def assert_bounded(payload):
        if len(payload) > 49152:
            raise AssertionError(f"unbounded helper frame: {len(payload)}")

    def open_source(self, size=SIZE, sha256=SHA256, relative=RELATIVE):
        return self.call(op="open_source", agentId=SOURCE, relativePath=relative, expectedSize=size, expectedSha256=sha256)

    def open_target(self, size=SIZE, sha256=SHA256, basename=BASENAME):
        return self.call(op="open_target", agentId=TARGET, destinationBasename=basename, expectedSize=size, expectedSha256=sha256)

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        if self.process.poll() is None:
            self.process.wait(timeout=5)
        self.process.stderr.close()
        self.process.stdout.close()


class Task43FileTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="task43-file-"))
        self.source = self.root / SOURCE
        self.target = self.root / TARGET
        self.source.mkdir()
        self.target.mkdir()
        self.helpers = []

    def tearDown(self):
        for helper in self.helpers:
            helper.close()
        shutil.rmtree(self.root)

    def helper(self):
        helper = HelperProcess(self.root)
        self.helpers.append(helper)
        return helper

    def write_source(self, data=DATA, relative=RELATIVE):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def assert_reason(self, response, reason):
        self.assertFalse(response["ok"])
        self.assertEqual(response["reason"], reason)
        self.assertNotIn("message", response)

    def copy_through(self, source, target, data=DATA):
        self.assertEqual(source.open_source(len(data), hashlib.sha256(data).hexdigest()), {"ok": True})
        self.assertEqual(target.open_target(len(data), hashlib.sha256(data).hexdigest()), {"ok": True, "existing": "absent"})
        offset = 0
        chunks = 0
        while offset < len(data):
            amount = min(32768, len(data) - offset)
            response = source.call(op="read", offset=offset)
            self.assertTrue(response["ok"])
            raw = base64.b64decode(response["data"], validate=True)
            self.assertEqual(raw, data[offset:offset + amount])
            self.assertEqual(len(raw), amount)
            self.assertEqual(base64.b64encode(raw).decode(), response["data"])
            self.assertEqual(target.call(op="write", offset=offset, data=response["data"]), {"ok": True, "nextOffset": offset + amount})
            offset += amount
            chunks += 1
        self.assertEqual(chunks, (len(data) + 32767) // 32768)
        digest = hashlib.sha256(data).hexdigest()
        self.assertEqual(source.call(op="source_finish"), {"ok": True, "size": len(data), "sha256": digest, "sourceReadAt": unittest.mock.ANY})
        verified = target.call(op="verify_target")
        self.assertTrue(verified["ok"])
        self.assertEqual((verified["size"], verified["sha256"]), (len(data), digest))
        return target.call(op="commit_target")

    def test_exact_size_atomic_round_trip_and_matching_retry(self):
        self.write_source()
        source = self.helper()
        target = self.helper()
        stored = self.copy_through(source, target)
        self.assertTrue(stored["ok"])
        self.assertEqual(stored["mode"], "copied")
        self.assertEqual((stored["size"], stored["sha256"]), (SIZE, SHA256))
        final = self.target / BASENAME
        self.assertEqual(Path(stored["actualPath"]), final)
        self.assertEqual(final.stat().st_size, SIZE)
        self.assertEqual(hashlib.sha256(final.read_bytes()).hexdigest(), SHA256)
        self.assertEqual(stat.S_IMODE(final.stat().st_mode), 0o600)
        self.assertEqual(sorted(path.name for path in self.target.iterdir()), [BASENAME])

        retry = self.helper()
        self.assertEqual(retry.open_target(), {"ok": True, "existing": "matching"})
        self.assertEqual(retry.call(op="commit_target")["mode"], "already_present")
        self.assertEqual(hashlib.sha256(final.read_bytes()).hexdigest(), SHA256)

    def test_different_existing_destination_is_never_overwritten(self):
        final = self.target / BASENAME
        final.write_bytes(b"do not replace")
        helper = self.helper()
        self.assert_reason(helper.open_target(), "destination_conflict")
        self.assertEqual(final.read_bytes(), b"do not replace")

    def test_symlink_destination_is_rejected_without_touching_target(self):
        outside = self.root / "outside"
        outside.write_bytes(DATA)
        os.symlink(outside, self.target / BASENAME)
        helper = self.helper()
        self.assert_reason(helper.open_target(), "destination_conflict")
        self.assertTrue((self.target / BASENAME).is_symlink())
        self.assertEqual(outside.read_bytes(), DATA)

    def test_source_traversal_symlinks_and_nonregular_files_are_rejected(self):
        cases = []
        traversal = self.helper()
        cases.append((traversal, "../outside", "unsafe_path"))
        for name, target in (("parent", self.source), ("final", self.root / "outside")):
            root = Path(tempfile.mkdtemp(prefix="task43-link-", dir=self.root))
            source = root / SOURCE
            source.mkdir()
            if name == "parent":
                os.symlink(target, source / "task-43-evidence")
            else:
                target.write_bytes(DATA)
                path = source / RELATIVE
                path.parent.mkdir(parents=True)
                os.symlink(target, path)
            helper = HelperProcess(root)
            self.helpers.append(helper)
            cases.append((helper, RELATIVE, "unsafe_path"))
        fifo = self.helper()
        fifo_path = self.source / RELATIVE
        fifo_path.parent.mkdir(parents=True)
        os.mkfifo(fifo_path)
        cases.append((fifo, RELATIVE, "unsafe_path"))
        for helper, relative, reason in cases:
            with self.subTest(relative=relative, reason=reason):
                self.assert_reason(helper.open_source(relative=relative), reason)

    def test_replaced_source_never_substitutes_another_inode(self):
        path = self.write_source()
        helper = self.helper()
        self.assertEqual(helper.open_source(), {"ok": True})
        first = base64.b64decode(helper.call(op="read", offset=0)["data"], validate=True)
        replacement = bytes((byte + 1) % 251 for byte in DATA)
        path.unlink()
        path.write_bytes(replacement)
        offset = len(first)
        while offset < SIZE:
            response = helper.call(op="read", offset=offset)
            offset += len(base64.b64decode(response["data"], validate=True))
        self.assert_reason(helper.call(op="source_finish"), "source_changed")
        self.assertNotEqual(first, replacement[:len(first)])

    def test_oversize_short_and_wrong_offset_writes_do_not_publish(self):
        self.write_source()
        target = self.helper()
        self.assertEqual(target.open_target(), {"ok": True, "existing": "absent"})
        oversized = base64.b64encode(DATA + b"x").decode()
        with self.assertRaises(AssertionError):
            target.call(op="write", offset=0, data=oversized)
        target.process.kill()
        target.process.wait(timeout=5)
        self.assertFalse((self.target / BASENAME).exists())

        target = self.helper()
        target.open_target()
        self.assert_reason(target.call(op="write", offset=1, data=base64.b64encode(b"x").decode()), "size_mismatch")
        short = base64.b64encode(DATA[:-1]).decode()
        with self.assertRaises(AssertionError):
            target.call(op="write", offset=0, data=short)

    def test_hash_mismatch_cannot_be_committed(self):
        target = self.helper()
        self.assertEqual(target.open_target(), {"ok": True, "existing": "absent"})
        changed = bytes([DATA[0] ^ 1]) + DATA[1:]
        response = target.call(op="write", offset=0, data=base64.b64encode(changed[:32768]).decode())
        self.assertTrue(response["ok"])
        offset = 32768
        while offset < SIZE:
            end = min(offset + 32768, SIZE)
            target.call(op="write", offset=offset, data=base64.b64encode(changed[offset:end]).decode())
            offset = end
        self.assert_reason(target.call(op="verify_target"), "hash_mismatch")
        self.assert_reason(target.call(op="commit_target"), "io_failed")
        self.assertFalse((self.target / BASENAME).exists())

    def test_existing_file_racing_commit_wins_without_overwrite(self):
        target = self.helper()
        self.assertEqual(target.open_target(), {"ok": True, "existing": "absent"})
        offset = 0
        while offset < SIZE:
            end = min(offset + 32768, SIZE)
            target.call(op="write", offset=offset, data=base64.b64encode(DATA[offset:end]).decode())
            offset = end
        self.assertTrue(target.call(op="verify_target")["ok"])
        final = self.target / BASENAME
        final.write_bytes(b"raced")
        self.assert_reason(target.call(op="commit_target"), "destination_conflict")
        self.assertEqual(final.read_bytes(), b"raced")

    def test_replaced_workspace_cannot_be_reported_stored(self):
        target = self.helper()
        self.assertEqual(target.open_target(), {"ok": True, "existing": "absent"})
        offset = 0
        while offset < SIZE:
            end = min(offset + 32768, SIZE)
            target.call(op="write", offset=offset, data=base64.b64encode(DATA[offset:end]).decode())
            offset = end
        self.assertTrue(target.call(op="verify_target")["ok"])
        moved = self.root / "moved-workspace"
        self.target.rename(moved)
        self.target.mkdir()
        self.assert_reason(target.call(op="commit_target"), "unsafe_path")
        self.assertFalse((self.target / BASENAME).exists())
        self.assertFalse((moved / BASENAME).exists())

    def test_disconnect_leaves_no_named_partial_file(self):
        target = self.helper()
        self.assertEqual(target.open_target(), {"ok": True, "existing": "absent"})
        target.call(op="write", offset=0, data=base64.b64encode(DATA[:32768]).decode())
        target.process.send_signal(signal.SIGKILL)
        target.process.wait(timeout=5)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_pipe_frames_are_bounded_and_errors_are_metadata_only(self):
        helper = self.helper()
        secret = "synthetic-secret-marker"
        response = helper.call(op="unknown", secret=secret)
        self.assert_reason(response, "io_failed")
        self.assertNotIn(secret, json.dumps(response))
        helper.process.stdin.write(b"x" * 49153 + b"\n")
        helper.process.stdin.flush()
        line = helper.process.stdout.readline(49153)
        self.assertLessEqual(len(line.rstrip(b"\n")), 49152)
        self.assertNotIn("x" * 100, line.decode())


if __name__ == "__main__":
    unittest.main()
