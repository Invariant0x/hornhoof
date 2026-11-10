"""Induce a refusal regression and check unittest diagnostics without printing a key."""
import io
import sys
import unittest

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests

case = PeerTests('test_r1_3_foreign_client_id_refused')
case.login = lambda *args, **kwargs: {'reject': False, 'unchange': True}
capture = io.StringIO()
result = unittest.TextTestRunner(stream=capture, verbosity=2).run(case)
leaked = case.key in capture.getvalue()
print('Induced failures:', len(result.failures), 'generated key present in captured output:', leaked)
assert not leaked, 'unittest diagnostics exposed the generated binding key'
