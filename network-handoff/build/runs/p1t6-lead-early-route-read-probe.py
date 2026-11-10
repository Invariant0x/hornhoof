"""Check that malformed NewProxy tests detect premature route straightening."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests
paths=[Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py'),
       Path('/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py')]
before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
case=PeerTests('test_newproxy_malformed_run_id_keeps_existing_route')
post=case.plugin_post
def premature_read(op,content):
    if op=='NewProxy':
        case.stack.api('GET','/api/v1/links/acme/route',key=case.key)
    return post(op,content)
case.plugin_post=premature_read
capture=io.StringIO()
with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
    result=unittest.TextTestRunner(stream=capture,verbosity=2).run(case)
after=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
print('Source/test stable during probe:',before==after)
print('Test failures:',len(result.failures),'errors:',len(result.errors),
      'premature route-read side effect detected:',bool(result.failures))
assert before==after,'source changed during isolated probe; rerun on stable source'
assert result.failures,'malformed-ID test missed a route read before validation'
