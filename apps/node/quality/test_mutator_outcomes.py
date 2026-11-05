"""Regression fixtures for honest mutation outcomes, not product mutation gates."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from mutator.cli import run
from mutator.metrics import load_history
from mutator.model import Site
from mutator.outcomes import RunError, classify
from mutator.runner import CommandResult
from mutator.workers import _execute


class BaselineTest(unittest.TestCase):
    def invoke(
        self, root: Path, command: str, *, coverage: bool = False
    ) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = run([
                "--root", str(root), "logic.ts",
                "--use-existing-coverage" if coverage else "--no-coverage", "--mutate-all",
                "--max-workers", "1", "--test-command", command,
            ])
        return code, output.getvalue()

    def test_zero_tests_is_a_run_error_even_with_exit_zero(self) -> None:
        summaries = (
            "Tests no tests", "Tests 0 passed", "Ran 0 tests", "collected 0 items",
            "No test files found, exiting with code 0", "Tests 1 skipped (1)",
        )
        for summary in summaries:
            with self.subTest(summary=summary), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "logic.ts").write_text("export function answer() { return 1; }\n")
                command = f"{sys.executable} -c 'print({json.dumps(summary)})'"
                code, output = self.invoke(root, command)
                self.assertEqual(code, 2, output)
                self.assertIn("Baseline failed", output)
                self.assertIn("no tests", output.lower())
                self.assertNotIn("100.0%", output)
                self.assertFalse((root / ".metrics").exists())

    def test_configuration_failure_aborts_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "logic.ts"
            source.write_text("export function answer() { return 1; }\n")
            code, output = self.invoke(root, "echo TSCONFIG_ERROR; exit 1")
            self.assertEqual(code, 2, output)
            self.assertIn("TSCONFIG_ERROR", output)
            self.assertNotIn("KILLED", output)
            self.assertEqual(source.read_text(), "export function answer() { return 1; }\n")

    def run_probe(self, script: str) -> tuple[int, str, str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logic.ts").write_text("export function answer() { return 1; }\n")
            (root / "probe.py").write_text(script)
            code, output = self.invoke(root, f"{sys.executable} probe.py")
            snapshot = root / ".metrics/mutate/logic.edn"
            return code, output, snapshot.read_text() if snapshot.exists() else ""

    def test_worker_failure_outcomes_do_not_count_as_kills(self) -> None:
        cases = [
            ("'mutation-workers' in str(Path.cwd())", "TSCONFIG_ERROR", None),
            ("'return 0;' in Path('logic.ts').read_text()", "error TS2322: Type mismatch", 1),
        ]
        for condition, error, compile_errors in cases:
            with self.subTest(error=error):
                code, output, snapshot = self.run_probe(
                    "from pathlib import Path\nimport sys\n"
                    f"failed = {condition}\n"
                    f"print({error!r} if failed else 'Tests 1 passed')\n"
                    "sys.exit(1 if failed else 0)\n"
                )
                self.assertEqual(code, 2, output)
                self.assertNotIn("100.0%", output)
                if compile_errors is None:
                    self.assertIn("TSCONFIG_ERROR", output)
                    self.assertNotIn("KILLED", output)
                    self.assertEqual(snapshot, "")
                else:
                    self.assertIn("COMPILE_ERROR", output)
                    self.assertIn(":compile-error 1", snapshot)
                    self.assertIn(":killed 0", snapshot)

    def test_root_run_retains_kills_and_uncovered_sites(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logic.ts").write_text(
                "export function answer() { return 1; }\n\n"
                "export function untouched() { return 0; }\n"
            )
            (root / "coverage").mkdir()
            (root / "coverage/lcov.info").write_text(
                "SF:logic.ts\nDA:1,1\nDA:3,0\nend_of_record\n"
            )
            (root / "probe.py").write_text(
                "from pathlib import Path\n"
                "assert 'return 1;' in Path('logic.ts').read_text()\n"
                "print('Tests 1 passed')\n"
            )
            code, output = self.invoke(root, f"{sys.executable} probe.py", coverage=True)
            self.assertEqual(code, 0, output)
            self.assertIn("KILLED", output)
            self.assertIn("UNCOVERED", output)
            self.assertRegex(output, r"Total\s+1\s+0\s+1\s+0\s+0\s+2\s+100.0%")
            self.assertEqual(
                set(load_history(root, "logic.ts").outcomes.values()),
                {"killed", "uncovered"},
            )

    def test_legacy_killed_outcomes_are_retested(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logic.ts").write_text("export function answer() { return 1; }\n")
            (root / "probe.py").write_text(
                "from pathlib import Path\n"
                "assert 'return 1;' in Path('logic.ts').read_text()\n"
                "print('Tests 1 passed')\n"
            )
            code, output = self.invoke(root, f"{sys.executable} probe.py")
            self.assertEqual(code, 0, output)
            snapshot = root / ".metrics/mutate/logic.edn"
            snapshot.write_text(snapshot.read_text().replace(":version 2", ":version 1"))
            (root / "probe.py").write_text("print('Tests 1 passed')\n")
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                code = run([
                    "--root", str(root), "logic.ts", "--no-coverage",
                    "--max-workers", "1", "--test-command", f"{sys.executable} probe.py",
                ])
            self.assertEqual(code, 3, output.getvalue())
            self.assertIn("SURVIVED", output.getvalue())


class WorkerOutcomeTest(unittest.TestCase):
    def test_unknown_command_failures_are_run_errors(self) -> None:
        for code, output in [(127, "missing command"), (1, "unexpected runner failure")]:
            with self.subTest(code=code), self.assertRaises(RunError):
                classify(CommandResult(code, False, 0.1, output))

    def test_workers_separate_failures_and_restore_the_source(self) -> None:
        cases = [
            (CommandResult(1, False, 0.1, "AssertionError: expected 42"), "killed"),
            (CommandResult(0, False, 0.1, "Tests 1 passed"), "survived"),
            (CommandResult(0, False, 0.1, "Tests 1 passed | 1 skipped (2)"), "survived"),
            (CommandResult(1, False, 0.1, "error TS2322: Type mismatch"), "compile_error"),
            (CommandResult(1, False, 0.1, "SyntaxError: Unexpected token"), "compile_error"),
            (CommandResult(124, True, 2, ""), "timeout"),
            (CommandResult(1, False, 0.1, "SyntaxError: bad token\nTests no tests"), "compile_error"),
        ]
        for result, expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "logic.ts"
                original = b"export function answer() { return 42; }\n"
                source.write_bytes(original)
                start = original.index(b"42")
                site = Site(
                    "logic.ts", "logic", "answer", "answer", 1,
                    start, start + 2, "42", "0", "number", "mutation",
                )

                class Runner:
                    def run(self, *args: object) -> CommandResult:
                        return result

                actual = _execute(
                    root, site, root, "logic.ts", original,
                    Runner(), "tests", root, 2, "logic.ts",
                )
                self.assertEqual(actual, expected)
                self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
