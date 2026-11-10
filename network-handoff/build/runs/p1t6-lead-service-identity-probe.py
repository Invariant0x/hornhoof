"""Check that the peer test rejects both services being wired to the data target."""
import io
import sys
import unittest

sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests

case = PeerTests('test_r5_1_peer_services')
original = case.stcp_proxies

def wrong_targets(*services):
    return original(*((name, secret, services[0][2]) for name, secret, port in services))

case.stcp_proxies = wrong_targets
capture = io.StringIO()
result = unittest.TextTestRunner(stream=capture, verbosity=2).run(case)
accepted = result.wasSuccessful()
print('Both services wired to data target accepted by test:', accepted,
      'failures:', len(result.failures), 'errors:', len(result.errors))
assert not accepted, 'peer test did not detect the wrong app service target'
