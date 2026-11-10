"""setup-relay.sh's write_private: a secret file is never world-readable, not even for a moment."""

import grp
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'relay' / 'private-file.sh'
SETUP = ROOT / 'relay' / 'setup-relay.sh'


def start_write_private(dest: Path, mode: str, group: str | None = None) -> subprocess.Popen:
    """Start write_private on a pipe the test controls; the caller writes the content."""
    command = ['sh', '-c', '. "$1"; shift; write_private "$@"', 'write_private',
               str(HELPER), str(dest), mode] + ([group] if group else [])
    return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)


def finish(process: subprocess.Popen) -> tuple[int, str, str]:
    out, err = process.stdout.read(), process.stderr.read()
    process.stdout.close()
    process.stderr.close()
    return process.wait(timeout=5), out.strip(), err


def run_sh(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(['sh', '-c', script], capture_output=True, text=True, timeout=30)


class WritePrivateTests(unittest.TestCase):
    def test_temp_file_is_private_while_the_content_arrives(self) -> None:
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'secret.env'
            process = start_write_private(dest, '640')
            process.stdin.write('first half\n')
            process.stdin.flush()
            tmp_file = Path(str(dest) + '.new')
            deadline = time.monotonic() + 5
            while not tmp_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(tmp_file.exists(),
                            'the temp file never appeared: write_private is not waiting on stdin')
            mode = stat.S_IMODE(tmp_file.stat().st_mode)
            self.assertEqual(mode & 0o077, 0, f'the temp file is readable by others: {oct(mode)}')
            process.stdin.write('second half\n')
            process.stdin.close()
            code, out, err = finish(process)
            self.assertEqual(code, 0, err)
            self.assertEqual(out, 'changed')
            self.assertEqual(dest.read_text(), 'first half\nsecond half\n')
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o640)

    def test_unchanged_content_keeps_the_destination(self) -> None:
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'secret.env'
            for content, answer in (('same content\n', 'changed'), ('same content\n', 'unchanged')):
                process = start_write_private(dest, '640')
                process.stdin.write(content)
                process.stdin.close()
                code, out, err = finish(process)
                self.assertEqual(code, 0, err)
                self.assertEqual(out, answer)
            self.assertEqual(dest.read_text(), 'same content\n')

    def test_unchanged_content_fixes_mode_and_group_in_place(self) -> None:
        # A re-run must repair a destination that drifted from its mode and group, without
        # replacing the file.
        group = grp.getgrgid(os.getgid()).gr_name
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'secret.env'
            dest.write_text('same content\n')
            dest.chmod(0o644)
            inode = dest.stat().st_ino
            process = start_write_private(dest, '640', group)
            process.stdin.write('same content\n')
            process.stdin.close()
            code, out, err = finish(process)
            self.assertEqual(code, 0, err)
            self.assertEqual(out, 'unchanged')
            self.assertEqual(dest.read_text(), 'same content\n')
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o640,
                             'an unchanged destination kept its wrong mode')
            self.assertEqual(dest.stat().st_ino, inode, 'an unchanged file was replaced')

    def test_changed_content_replaces_the_destination(self) -> None:
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'secret.env'
            for content, answer in (('old\n', 'changed'), ('new\n', 'changed')):
                process = start_write_private(dest, '640')
                process.stdin.write(content)
                process.stdin.close()
                code, out, err = finish(process)
                self.assertEqual(code, 0, err)
                self.assertEqual(out, answer)
            self.assertEqual(dest.read_text(), 'new\n')

    def test_failed_rename_reports_failure(self) -> None:
        # The destination is a directory the caller cannot write: the rename fails, the
        # helper must say so with a non-zero status and never print "changed".
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'blocked'
            dest.mkdir()
            dest.chmod(0o555)
            try:
                process = start_write_private(dest, '640')
                process.stdin.write('content\n')
                process.stdin.close()
                code, out, err = finish(process)
                self.assertNotEqual(code, 0, f'rename failure reported success: {out} {err}')
                self.assertNotEqual(out, 'changed')
                self.assertTrue(dest.is_dir())
                self.assertFalse(Path(str(dest) + '.new').exists(), 'the temp file was left behind')
            finally:
                dest.chmod(0o755)

    def test_call_does_not_clobber_caller_variables(self) -> None:
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'out'
            caller = ('dest=caller-dest', 'mode=caller-mode', 'group=caller-group', 'tmp=caller-tmp')
            script = (f'. {shlex.quote(str(HELPER))}\n'
                      + '\n'.join(caller) + '\n'
                      + f'write_private {shlex.quote(str(dest))} 640 > /dev/null <<\'EOF\'\n'
                      + 'data\nEOF\n'
                      + 'printf \'%s %s %s %s\\n\' "$dest" "$mode" "$group" "$tmp"\n')
            result = run_sh(script)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'caller-dest caller-mode caller-group caller-tmp\n')

    def test_failing_producer_keeps_the_destination(self) -> None:
        # The pattern setup-relay.sh uses: produce the content first, then hand it to
        # write_private. A failing producer must abort before anything is written.
        with tempfile.TemporaryDirectory(prefix='hornhoof-private-') as tmp:
            dest = Path(tmp) / 'frps.toml'
            dest.write_text('good content\n')
            script = (f'. {shlex.quote(str(HELPER))}\nset -eu\n'
                      f'content=$(cat {shlex.quote(str(Path(tmp) / "missing-template"))})\n'
                      + f'printf \'%s\\n\' "$content" | write_private {shlex.quote(str(dest))} 640\n')
            result = run_sh(script)
            self.assertNotEqual(result.returncode, 0,
                                f'a failing producer kept the script running: {result.stdout}')
            self.assertEqual(dest.read_text(), 'good content\n')

    def test_setup_feeds_write_private_only_checked_content(self) -> None:
        # setup-relay.sh must never pipe a producer straight into write_private: under
        # set -e a failing producer in a pipeline would not stop the script, and an empty
        # file would replace good content.
        for number, line in enumerate(SETUP.read_text().splitlines(), start=1):
            if 'write_private' in line and '|' in line:
                producer = line.split('|', 1)[0].strip()
                if '$(' in producer:
                    producer = producer.split('$(', 1)[1].strip()
                self.assertRegex(producer, r"^printf '%s\\n' \"\$[a-z_]+\"$", f'line {number}: {line}')

    def test_shell_files_parse(self) -> None:
        # sh -n checks one file per invocation; check each script on its own.
        for script in (SETUP, HELPER):
            with self.subTest(script=script.name):
                result = subprocess.run(['sh', '-n', str(script)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
