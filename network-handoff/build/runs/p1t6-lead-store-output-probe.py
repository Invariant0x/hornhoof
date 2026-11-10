"""Induce plaintext-store observation without printing captured credentials."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests

source = Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py')
tests = Path('/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py')
before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, tests)]
case = PeerTests('test_r6_2_visitor_key')
original = case.visitor_key
keys = []
def issue(*args, **kwargs):
    status, body = original(*args, **kwargs)
    if status == 200:
        keys.append(body['visitorKey'])
    return status, body
case.visitor_key = issue
case.visitor_key_hash = lambda: keys[-1]
capture = io.StringIO()
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    result = unittest.TextTestRunner(stream=capture, verbosity=2).run(case)
leaked = any(key in capture.getvalue() for key in keys)
after = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, tests)]
print('Source/test stable during probe:', before == after)
print('Induced failures:', len(result.failures), 'errors:', len(result.errors),
      'generated visitor key present in captured output:', leaked)
assert before == after, 'source changed during isolated probe; rerun on stable source'
assert result.failures, 'unsafe plaintext-store observation was not detected'
assert not leaked, 'unittest storage diagnostics exposed the generated visitor key'
