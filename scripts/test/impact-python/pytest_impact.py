"""Conservative Python import graph. This is an explicit input port, not a runner."""

import json
import sys
from pathlib import Path
from typing import TypedDict


class Selection(TypedDict):
    status: str
    selected: list[str]
    reason: str | None


def select_tests(
    root: Path, files: list[str], tests: list[str], changed: list[str]
) -> Selection:
    return {"status": "unavailable", "selected": [], "reason": "not_implemented"}


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
