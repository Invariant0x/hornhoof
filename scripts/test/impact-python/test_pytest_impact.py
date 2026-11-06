"""Behavior tests for the Python input graph, including actual selected pytest."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pytest_impact import select_tests


def project(root: Path, extra: dict[str, str] | None = None) -> list[str]:
    sources = {
        "src/prices.py": "def total():\n    return 7\n",
        "src/labels.py": "def label():\n    return 'basket'\n",
        "src/basket/__init__.py": "",
        "src/basket/summary.py": "from prices import total\nvalue = total()\n",
        "src/basket/report.py": "from .summary import value\n",
        "tests/test_prices.py": "from prices import total\ndef test_total():\n"
        "    assert total() == 7\n",
        "tests/test_labels.py": "from labels import label\ndef test_label():\n"
        "    assert label() == 'basket'\n",
        "tests/test_report.py": "from basket.report import value\ndef test_report():\n"
        "    assert value == 7\n",
    }
    sources.update(extra or {})
    for name, source in sources.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
    return sorted(sources)


def inventory_tests(files: list[str]) -> list[str]:
    return [file for file in files if file.startswith("tests/test_")]


def test_transitive_relative_edges_select_only_dependents(tmp_path: Path) -> None:
    files = project(tmp_path)
    result = select_tests(tmp_path, files, inventory_tests(files), ["src/prices.py"])
    assert result == {
        "status": "ready",
        "selected": ["tests/test_prices.py", "tests/test_report.py"],
        "reason": None,
    }


def test_selected_files_run_with_real_pytest(tmp_path: Path) -> None:
    files = project(tmp_path)
    result = select_tests(tmp_path, files, inventory_tests(files), ["src/labels.py"])
    assert result["status"] == "ready"
    assert result["selected"] == ["tests/test_labels.py"]
    output = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *result["selected"]],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(tmp_path / "src")},
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert output.returncode == 0, output.stdout + output.stderr
    assert "1 passed" in output.stdout


def test_changed_test_itself_is_selected(tmp_path: Path) -> None:
    files = project(tmp_path)
    assert select_tests(
        tmp_path, files, inventory_tests(files), ["tests/test_labels.py"]
    )["selected"] == ["tests/test_labels.py"]


def test_proven_unreferenced_module_has_no_tests(tmp_path: Path) -> None:
    files = project(tmp_path, {"src/unreferenced.py": "unused = 1\n"})
    assert select_tests(
        tmp_path, files, inventory_tests(files), ["src/unreferenced.py"]
    ) == {
        "status": "ready",
        "selected": [],
        "reason": None,
    }


@pytest.mark.parametrize(
    "extra",
    [
        {"tests/conftest.py": "# Hook dependencies are not a static import graph.\n"},
        {"src/prices.py": "import importlib\nvalue = importlib.import_module('x')\n"},
        {"src/prices.py": "loader = __import__\nvalue = loader('x')\n"},
        {"src/prices.py": "eval('x')\n"},
        {"src/prices.py": "exec('x = 1')\n"},
        {"src/prices.py": "from unknown_dependency import value\n"},
        {"src/prices.py": "from basket import *\n"},
        {"src/prices.py": "def broken(\n"},
        {"prices.py": "value = 99\n"},
    ],
)
def test_uncertain_graph_is_unavailable(tmp_path: Path, extra: dict[str, str]) -> None:
    files = project(tmp_path, extra)
    result = select_tests(tmp_path, files, inventory_tests(files), ["src/prices.py"])
    assert result["status"] == "unavailable"
    assert result["selected"] == []
    assert result["reason"] != "not_implemented"


@pytest.mark.parametrize("path", ["../secret.py", "/etc/passwd", "src/../a.py"])
def test_unsafe_paths_do_not_open_files(tmp_path: Path, path: str) -> None:
    files = project(tmp_path)
    assert select_tests(tmp_path, files, inventory_tests(files), [path])["reason"] == (
        "invalid_inventory"
    )


def test_symlink_cannot_import_outside_the_package(tmp_path: Path) -> None:
    files = project(tmp_path)
    path = tmp_path / "src/prices.py"
    path.unlink()
    path.symlink_to(Path(__file__).resolve())
    assert (
        select_tests(tmp_path, files, inventory_tests(files), ["src/prices.py"])[
            "reason"
        ]
        == "invalid_inventory"
    )


def test_missing_or_uninventoried_files_are_unavailable(tmp_path: Path) -> None:
    files = project(tmp_path)
    assert (
        select_tests(tmp_path, files, inventory_tests(files), ["src/missing.py"])[
            "status"
        ]
        == "unavailable"
    )
    assert (
        select_tests(tmp_path, files, ["tests/missing.py"], ["src/prices.py"])["status"]
        == "unavailable"
    )


def test_module_cycles_terminate_and_keep_all_dependents(tmp_path: Path) -> None:
    files = project(
        tmp_path,
        {"src/prices.py": "import labels\n", "src/labels.py": "import prices\n"},
    )
    assert select_tests(tmp_path, files, inventory_tests(files), ["src/labels.py"])[
        "selected"
    ] == ["tests/test_labels.py", "tests/test_prices.py", "tests/test_report.py"]


def test_package_initializer_is_a_dependency(tmp_path: Path) -> None:
    files = project(tmp_path)
    assert select_tests(
        tmp_path, files, inventory_tests(files), ["src/basket/__init__.py"]
    )["selected"] == ["tests/test_report.py"]


def test_cli_emits_json_without_importing_repository_modules(tmp_path: Path) -> None:
    files = project(tmp_path, {"src/prices.py": "raise RuntimeError('not executed')\n"})
    command = [sys.executable, str(Path(__file__).with_name("pytest_impact.py"))]
    output = subprocess.run(
        command,
        input=json.dumps(
            {
                "root": str(tmp_path),
                "files": files,
                "tests": inventory_tests(files),
                "changed": ["src/prices.py"],
            }
        ),
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert output.returncode == 0
    assert json.loads(output.stdout)["selected"] == [
        "tests/test_prices.py",
        "tests/test_report.py",
    ]
