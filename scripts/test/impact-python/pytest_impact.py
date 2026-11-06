"""Conservative Python import graph. This is an explicit input port, not a runner."""

import ast
import json
import sys
from pathlib import Path, PurePosixPath
from typing import TypedDict


class Selection(TypedDict):
    status: str
    selected: list[str]
    reason: str | None


def checked_path(root: Path, name: str) -> Path:
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or any(part in (".", "..") for part in name.split("/"))
        or "\\" in name
        or ":" in name
        or any(ord(char) < 32 for char in name)
    ):
        raise ValueError("invalid_inventory")
    absolute = root / name
    if absolute.resolve() != absolute or not absolute.is_file():
        raise ValueError("invalid_inventory")
    return absolute


def validate(
    root: Path, files: list[str], tests: list[str], changed: list[str]
) -> None:
    if not set(tests + changed).issubset(files):
        raise ValueError("invalid_inventory")
    for name in files:
        checked_path(root, name)
        if not name.endswith(".py"):
            raise ValueError("invalid_inventory")
        if PurePosixPath(name).name == "conftest.py":
            raise ValueError("conftest_unsupported")


def module_name(name: str) -> str:
    parts = list(PurePosixPath(name).with_suffix("").parts)
    if parts[0] == "src":
        parts.pop(0)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def module_index(files: list[str]) -> dict[str, str]:
    modules: dict[str, str] = {}
    for file in files:
        name = module_name(file)
        if not name or name in modules:
            raise ValueError("ambiguous_module")
        modules[name] = file
    return modules


def resolve_module(name: str, modules: dict[str, str]) -> set[str]:
    parts = name.split(".")
    if name not in modules:
        if parts[0] in {"importlib", "runpy", "pkgutil"}:
            raise ValueError("dynamic_import")
        if parts[0] in sys.stdlib_module_names or parts[0] == "pytest":
            return set()
        raise ValueError("external_import")
    dependencies = {modules[name]}
    for size in range(1, len(parts)):
        parent = modules.get(".".join(parts[:size]))
        if parent is not None:
            dependencies.add(parent)
    return dependencies


def relative_module(node: ast.ImportFrom, file: str) -> str:
    if not node.level:
        return node.module or ""
    package = module_name(file).split(".")
    if not file.endswith("/__init__.py"):
        package.pop()
    if len(package) < node.level:
        raise ValueError("relative_import_unknown")
    prefix = package[: len(package) - node.level + 1]
    return ".".join(prefix + ([node.module] if node.module else []))


def import_dependencies(
    node: ast.Import | ast.ImportFrom, file: str, modules: dict[str, str]
) -> set[str]:
    if isinstance(node, ast.Import):
        return set().union(
            *(resolve_module(alias.name, modules) for alias in node.names)
        )
    if any(alias.name == "*" for alias in node.names):
        raise ValueError("star_import")
    base = relative_module(node, file)
    dependencies = resolve_module(base, modules)
    for alias in node.names:
        candidate = f"{base}.{alias.name}"
        if candidate in modules:
            dependencies.update(resolve_module(candidate, modules))
    return dependencies


def ancestor_initializers(file: str, modules: dict[str, str]) -> set[str]:
    parts = module_name(file).split(".")
    parents = (modules.get(".".join(parts[:size])) for size in range(1, len(parts)))
    return {
        parent
        for parent in parents
        if parent is not None and parent.endswith("/__init__.py")
    }


def dynamic_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def file_dependencies(file: str, root: Path, modules: dict[str, str]) -> set[str]:
    tree = ast.parse(checked_path(root, file).read_text(encoding="utf-8"))
    dependencies = ancestor_initializers(file, modules)
    for node in ast.walk(tree):
        name = dynamic_name(node)
        if name == "pytest_plugins":
            raise ValueError("plugin_unsupported")
        if name in {
            "__import__",
            "__builtins__",
            "eval",
            "exec",
            "compile",
            "globals",
            "locals",
        }:
            raise ValueError("dynamic_import")
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            dependencies.update(import_dependencies(node, file, modules))
    return dependencies


def affected_files(graph: dict[str, set[str]], changed: list[str]) -> set[str]:
    affected = set(changed)
    while True:
        additions = {
            file for file, dependencies in graph.items() if dependencies & affected
        } - affected
        if not additions:
            return affected
        affected.update(additions)


def select_tests(
    root: Path, files: list[str], tests: list[str], changed: list[str]
) -> Selection:
    """Files and test inventory must be complete for one package at this checkout.

    Only package-root and src-layout imports are supported. Unknown plugins,
    dynamic imports, conftest hooks and ambiguous modules require the whole package.
    Repository modules are parsed, never imported or evaluated here.
    """
    try:
        root = root.resolve()
        validate(root, files, tests, changed)
        modules = module_index(files)
        graph = {file: file_dependencies(file, root, modules) for file in files}
        selected = sorted(set(tests) & affected_files(graph, changed))
        return {"status": "ready", "selected": selected, "reason": None}
    except (OSError, UnicodeError):
        reason = "invalid_inventory"
    except SyntaxError:
        reason = "syntax_error"
    except ValueError as error:
        reason = str(error)
    return {"status": "unavailable", "selected": [], "reason": reason}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(
        json.dumps(
            select_tests(
                Path(request["root"]),
                request["files"],
                request["tests"],
                request["changed"],
            )
        )
    )
