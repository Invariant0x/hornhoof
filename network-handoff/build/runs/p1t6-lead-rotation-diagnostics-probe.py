"""Capture rotation/rebind assertion failures without displaying credentials."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests

source = Path('/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py')
before = hashlib.sha256(source.read_bytes()).hexdigest()
results = []
for mode in ('rotation-status', 'rotation-reuse', 'binding-reuse', 'issuance-auth-bypass'):
    method = ('test_r6_2_visitor_key_dies_with_the_binding_api'
              if mode == 'binding-reuse' else 'test_r5_1_peer_limits')
    if mode == 'issuance-auth-bypass':
        method = 'test_r6_2_visitor_key'
    case = PeerTests(method)
    keys = []
    if mode == 'binding-reuse':
        setup = case.setUp

        def setup_with_reuse():
            setup()
            bind = case.stack.bind

            def reused_binding(*args, **kwargs):
                body = bind(*args, **kwargs)
                keys.append(case.key)
                return dict(body, key=case.key)
            case.stack.bind = reused_binding
        case.setUp = setup_with_reuse
    else:
        issue = case.visitor_key

        def unsafe_rotation(*args, **kwargs):
            if mode == 'issuance-auth-bypass' and kwargs.get('key') == 'wrong':
                return 200, {'visitorKey': keys[0]}
            status, body = issue(*args, **kwargs)
            if status == 200:
                keys.append(body['visitorKey'])
                if len(keys) == 2:
                    if mode == 'rotation-status':
                        return 500, body
                    return status, {'visitorKey': keys[0]}
            return status, body
        case.visitor_key = unsafe_rotation
    capture = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = unittest.TextTestRunner(stream=capture, verbosity=2).run(case)
    leaked = any(key in capture.getvalue() for key in keys)
    print(mode, 'failures:', len(result.failures), 'errors:', len(result.errors),
          'credential leaked:', leaked)
    results.append(bool(result.failures) and not result.errors and not leaked)
stable = before == hashlib.sha256(source.read_bytes()).hexdigest()
print('Source/test stable during probe:', stable)
assert stable, 'test source changed during probe; repeat on stable source'
assert all(results), 'rotation/rebind assertion diagnostics exposed generated credentials'
