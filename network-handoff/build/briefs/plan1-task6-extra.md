- The Login check's `GET <api>/api/clients?runId=<run_id>` is a dashboard read inside a plugin call: it goes through
  `_dash_get` on the call's 1 s budget, and a spent budget or a dashboard error refuses with `relay error: frps does
  not answer`. Read the real answer's shape from frps 0.71.1 first (the harness's `dash('/api/clients')`) and pin it
  in a test before you rely on it; an answer that lacks a field you need reads as unknown, never as "no session".
- Visitor keys and stcp secrets are never logged, traced or returned, except the one `{visitorKey}` answer. The
  visitor key is stored only as a hash, compared in constant time (`hmac.compare_digest`) as the link key is.
- Every new SQLite write goes through `write()`; every new API write path answers busy as the others do.
