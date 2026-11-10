Build lead's rulings on your stop (they override the plan):

1. The sandbox keeps .git read-only, so do not `git add` and do not make a git dir elsewhere (I removed
   /private/tmp/hornhoof-edge-task1-git). `test_public.py` lists the files to check with
   `git ls-files --cached --others --exclude-standard` (tracked files plus every file the next `git add -A` would
   track, .gitignore respected), `.woff2` skipped. Run the tests without `git add`. Wherever the plan says "after
   `git add -A`", just run the test.
2. The host check skips Python names its pattern matches: a set `CODE_NAMES = {'threading.local'}` beside
   `ALLOWED_HOSTS`, with a comment that these are Python names, not hosts, and that a reviewer adds to it as to
   ALLOWED_HOSTS. Do not loosen the pattern itself.

Go on from Step 3 with the rest of the task as briefed (Steps 3 to 5, 7 to 11; no commits; Step 12 is mine). Run the
whole relay suite with both `python3` and `/opt/homebrew/bin/python3.12` at the end, and report as briefed.
