"""Runs the pinned mutator on a test helper such as apps/server/test/fake-relay.ts.

mutator skips every path under a test/ folder. A fake that mirrors a contract is real code that later plans rest on, so the
build wants its mutants too. This changes nothing in the tool: it only tells this one process that no path is a test file.
"""

import crapper.discover

crapper.discover.is_test_file = lambda path: False

from mutator.cli import main  # noqa: E402

raise SystemExit(main())
