"""Regression checks that a part of a run on a node is a project like any other to the quality tools.

crapper and dryer take a file for a test when any folder on its absolute path is called test, tests or
the like, and mutator asks crapper. Under such a folder they find no source to look at and still exit 0,
which reads like a clean result. PART_REPO is where a node with the data folder /data runs a part, and
../test/tests-run.test.ts holds it to the node's code. The image runs each class below by name, with its
tool's own Python.
"""

import unittest
from contextlib import redirect_stderr
from importlib import import_module
from io import StringIO
from pathlib import Path

PART_REPO = Path("/data/runs/part-1/repo")
SOURCES = [
    PART_REPO / name
    for name in ["apps/node/src/tests.ts", "apps/web/src/App.tsx", "src/add.py", "add.go", "src/add.clj"]
]
TESTS = [
    PART_REPO / name
    for name in [
        "apps/node/test/tests-run.test.ts",
        "apps/web/e2e/tree.spec.ts",
        "src/add.test.ts",
        "src/test_add.py",
        "tests/add.py",
        "spec/add.py",
        "add_test.go",
    ]
]


class PartPaths(unittest.TestCase):
    def assert_tells_apart(self, tool: str) -> None:
        is_test_file = import_module(f"{tool}.discover").is_test_file
        self.assertEqual([path for path in SOURCES if is_test_file(path)], [])
        self.assertEqual([path for path in TESTS if not is_test_file(path)], [])


class CrapperPaths(PartPaths):
    def test_crapper_tells_sources_from_tests(self) -> None:
        self.assert_tells_apart("crapper")


class DryerPaths(PartPaths):
    def test_dryer_tells_sources_from_tests(self) -> None:
        self.assert_tells_apart("dryer")


class MutatorPaths(unittest.TestCase):
    def test_mutator_takes_the_sources_and_skips_the_tests(self) -> None:
        from mutator.cli import _explicit_sources
        from mutator.crapper_link import ensure_crapper

        with redirect_stderr(StringIO()):
            chosen = _explicit_sources(SOURCES + TESTS, ensure_crapper())
        self.assertEqual(chosen, SOURCES)


if __name__ == "__main__":
    unittest.main()
