"""Check that the HTTP issuance test detects deletion of the new owner credential."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import VisitorKeyLifecycleTests
paths=[Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py'),
       Path('/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py')]
before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
case=VisitorKeyLifecycleTests('test_http_visitor_key_authorized_before_release_answers_404')
setup=case.setUp
def prepared():
    setup()
    relay=case.relay
    store=relay.store_visitor_key
    def unsafe_stale_delete(name, visitor_hash, link_hash):
        stored=store(name, visitor_hash, link_hash)
        if not stored:
            relay.write('DELETE FROM visitor_keys WHERE name = ?', (name,))
        return stored
    relay.store_visitor_key=unsafe_stale_delete
case.setUp=prepared
capture=io.StringIO()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result=unittest.TextTestRunner(stream=capture,verbosity=2).run(case)
after=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
print('Source/test stable during probe:',before==after)
print('Test failures:',len(result.failures),'errors:',len(result.errors),
      'unsafe stale-delete mutation detected:',bool(result.failures))
assert before==after,'source changed during isolated probe; rerun on stable source'
assert result.failures,'HTTP race test missed stale issuer deleting the new owner credential'
