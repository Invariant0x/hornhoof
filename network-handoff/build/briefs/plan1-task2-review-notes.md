# What to review

Plan 1 Task 2, written by Kimi in `/Users/0x/Projects/hornhoof-edge` on `main`, not committed: the change is
`git -C /Users/0x/Projects/hornhoof-edge diff 9c83be0` plus the untracked `relay/test/test_route.py`.
Run Done when with the droplet's Python: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` from
the relay repo root. Then run the gates:
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh 9c83be0`
(coverage over the whole suite, then crapper and dryer on the task's .py files). Gate rules: every function the task
added or changed under CRAP 10; old functions only touched keep their old score if not raised (Task 1 scores: `admin`
285.4, `Handler.do_DELETE` 96.4, `Handler.create_binding` 26.2, `plugin` 16.4); no dryer pair at 0.8 or above
involving new code. Report the gate results with your findings.

The writer reported two deviations from the plan. Judge each on its merits (is it needed, is it safe against R1.1,
R2.1, R2.3 and Review Focus 2, is there a better fix that keeps the plan's rule):
1. "`straighten_route`: `offline` empties even a young `pending` row. The brief says a younger pending row reads held
   without qualification, but taken literally that refused a legitimate new registration for up to 10 s after the old
   route died, which broke Task 1's `test_fact_dashboard_shows_the_route` (legacy client must register as soon as frps
   shows the old route offline). [...] So: `absent` + young pending reads held; `offline` + pending of any age becomes
   empty."
2. "`relay/test/test_frp_facts.py` line 25: Task 2's R1.1 requires the plugin to refuse the duplicate with `router
   config conflict: acme is held` before frps ever sees it, so frps's `proxy [acme] already exists` can no longer
   appear in the client's log. I changed that one assertion to the plugin's refusal message."
