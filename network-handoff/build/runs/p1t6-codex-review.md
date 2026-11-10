**Critical**

- [relay/relay.py:618](/Users/0x/Projects/hornhoof-edge/relay/relay.py:618): Empty client ids bypass takeover checks. Reproduced with another binding’s key and a live run id: real frps displaced the original session. Check ownership for every nonempty run id while preserving legitimate legacy reconnects.
- [relay/relay.py:758](/Users/0x/Projects/hornhoof-edge/relay/relay.py:758): Visitor keys survive release and rebinding. The previous owner’s visitor key successfully logged into real frps after rebinding with a new link key. Invalidate visitor credentials atomically with the binding lifecycle.

**Important**

- [relay/test/test_peers.py:215](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:215): Peer tests never verify route-generation isolation. The service test passed with an injected fault writing generation 99. Assert no peer route rows and unchanged link holder/generation.
- [relay/test/test_peers.py:68](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:68): Both services target the same echo server, and only `app` is visited. Use two distinguishable targets and verify both services independently.
- [relay/test/test_peers.py:99](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:99): Wrong-secret verification accepts HTTP 200 with an empty body, confirmed by a probe. Require EOF/reset without any HTTP response.
- [README.md:24](/Users/0x/Projects/hornhoof-edge/README.md:24): The app-only tunnel promise contradicts the newly supported peer data service. Update it to describe both supported services.

**Minor:** None.

The four fixture substitutions are justified; assertions remain unchanged. No repository files were modified.

Done when ran from the relay root:

```sh
PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v
```

**84 passed, 0 failed**, in 362.838 seconds. Exit status 0. `nice` reported that priority adjustment was denied.