"""Induce an obsolete issuance returning 200; report only whether diagnostics leak."""
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
api=case.api
keys=[]
def prepared():
    setup()
    store=case.relay.store_visitor_key
    def unsafe_success(*args, **kwargs):
        store(*args, **kwargs)
        return True
    case.relay.store_visitor_key=unsafe_success
def request(*args, **kwargs):
    status, body=api(*args, **kwargs)
    if isinstance(body,dict) and isinstance(body.get('visitorKey'),str):
        keys.append(body['visitorKey'])
    return status, body
case.setUp=prepared
case.api=request
capture=io.StringIO()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result=unittest.TextTestRunner(stream=capture,verbosity=2).run(case)
leaked=any(key in capture.getvalue() for key in keys)
after=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
print('Source/test stable during probe:', before==after)
print('Induced failures:',len(result.failures),'errors:',len(result.errors),
      'generated visitor key present in captured output:',leaked)
assert before==after,'source changed during isolated probe; rerun on stable source'
assert result.failures,'unsafe successful stale issuance was not detected'
assert not leaked,'unittest HTTP race diagnostics exposed the generated visitor key'
