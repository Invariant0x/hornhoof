"""Prepared LCOV must score the requested source without starting tests."""

import contextlib
import io
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from crapper.cli import run


class PreparedCoverageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "logic.py").write_text("def answer():\n    return 42\n")
        self.report = self.root / "saved.lcov"
        self.report.write_text("SF:logic.py\nDA:1,1\nDA:2,1\nend_of_record\n")
        self.marker = self.root / "runner-called"
        self.command = f"touch {self.marker}"

    def invoke(self, *options: str) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with patch(
                "crapper.cli.run_coverage",
                side_effect=AssertionError("Test runner invoked"),
            ) as runner:
                code = run(["--root", str(self.root), "logic.py", *options])
                self.assertEqual(runner.call_count, 0)
        return code, output.getvalue()

    def test_explicit_report_scores_coverage_without_running_tests(self) -> None:
        started = time.monotonic()
        code, output = self.invoke("--coverage-report", "saved.lcov", "--threshold", "1")
        self.assertEqual(code, 0, output)
        self.assertIn("100.0%", output)
        self.assertFalse(self.marker.exists())
        self.assertIn(":coverage 100.0", (self.root / ".metrics/crap.edn").read_text())
        print(f"Prepared coverage: {time.monotonic() - started:.4f}s, 0 test runner calls")

    def test_existing_coverage_skips_the_test_runner(self) -> None:
        directory = self.root / "coverage"
        directory.mkdir()
        self.report.rename(directory / "lcov.info")
        (self.root / "pyproject.toml").write_text('[project]\nname="probe"\n')
        code, output = self.invoke("--use-existing-coverage", "--threshold", "1")
        self.assertEqual(code, 0, output)
        self.assertIn("100.0%", output)
        self.assertFalse(self.marker.exists())

    def test_invalid_reports_fail_without_writing_metrics(self) -> None:
        cases = [
            ("missing.lcov", None, "missing.lcov"),
            ("saved.lcov", "not a coverage report\n", "No LCOV records"),
        ]
        for name, contents, reason in cases:
            with self.subTest(name=name):
                if contents is not None:
                    self.report.write_text(contents)
                code, output = self.invoke("--coverage-report", name)
                self.assertNotEqual(code, 0)
                self.assertIn(reason, output)
                self.assertFalse((self.root / ".metrics").exists())

    def test_report_and_generation_command_are_rejected_together(self) -> None:
        code, output = self.invoke(
            "--coverage-report", "saved.lcov", "--coverage-command", self.command
        )
        self.assertNotEqual(code, 0)
        self.assertIn("cannot be combined", output)
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
