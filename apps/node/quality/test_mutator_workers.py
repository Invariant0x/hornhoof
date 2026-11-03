"""Regression checks for Hornhoof's patch to the pinned 0BSD mutator."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from mutator.workers import create_workers


class WorkerModulesTest(unittest.TestCase):
    def test_additional_bootstrap_modules_remain_executable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "component.tsx"
            source.write_text("export const Component = () => <p>Ready</p>;\n")
            bootstrap = root / "bootstrap.mjs"
            bootstrap.write_text("#!/usr/bin/env node\nconsole.log('bootstrap ready');\n")
            bootstrap.chmod(0o755)
            private = root / "private.ts"
            private.write_text("export const example = true;\n")
            private.chmod(0o600)
            worker = create_workers(
                root / "target/run-test", root, "component.tsx", source.read_bytes(), 1
            )[0]
            result = subprocess.run(
                [str(worker / "bootstrap.mjs")], capture_output=True, text=True, check=True
            )
            self.assertEqual(result.stdout, "bootstrap ready\n")
            self.assertEqual((worker / "private.ts").stat().st_mode & 0o777, 0o600)

    def test_other_languages_keep_the_upstream_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "server.py"
            source.write_text("ready = True\n")
            bootstrap = root / "setup.ts"
            bootstrap.write_text("globalThis.ready = true;\n")
            worker = create_workers(
                root / "target/run-test", root, "server.py", source.read_bytes(), 1
            )[0]
            self.assertEqual((worker / "setup.ts").resolve(), bootstrap)

    def test_bootstrap_modules_stay_inside_the_worker(self) -> None:
        # Vitest loads setupFiles itself; no test imports this module.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "src/component.tsx"
            source.parent.mkdir()
            source.write_text("export const Component = () => <p>Ready</p>;\n")
            bootstrap = root / "test/setup.ts"
            bootstrap.parent.mkdir()
            bootstrap.write_text("globalThis.ready = true;\n")
            workers = create_workers(
                root / "target/run-test", root, "src/component.tsx", source.read_bytes(), 2
            )
            for worker in workers:
                setup = worker / "test/setup.ts"
                self.assertTrue(setup.resolve().is_relative_to(worker))
                self.assertEqual(setup.read_text(), bootstrap.read_text())
            (workers[0] / "test/setup.ts").write_text("worker zero only\n")
            self.assertEqual(bootstrap.read_text(), "globalThis.ready = true;\n")
            self.assertEqual((workers[1] / "test/setup.ts").read_text(), bootstrap.read_text())

    def test_relative_server_importers_stay_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "src/server.ts"
            source.parent.mkdir()
            source.write_text("export const ready = true;\n")
            test = root / "test/server.test.ts"
            test.parent.mkdir()
            test.write_text("import {ready} from '../src/server.js';\n")
            worker = create_workers(
                root / "target/run-test", root, "src/server.ts", source.read_bytes(), 1
            )[0]
            self.assertTrue((worker / "test/server.test.ts").resolve().is_relative_to(worker))
            (worker / "src/server.ts").write_text("export const ready = false;\n")
            self.assertEqual(source.read_text(), "export const ready = true;\n")


if __name__ == "__main__":
    unittest.main()
