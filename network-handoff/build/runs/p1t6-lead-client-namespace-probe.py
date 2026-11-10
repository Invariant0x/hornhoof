"""Probe preemptive client-ID namespace capture through native legacy run_id."""
import hashlib
from pathlib import Path
import secrets
import sys
import tempfile
sys.path.insert(0,'/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0,'/Users/0x/Projects/hornhoof-edge/relay/test')
from harness import Stack,_wait
from test_peers import FrpsWireSession
source=Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py')
before=hashlib.sha256(source.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='hornhoof-lead-namespace-') as tmp:
 with Stack(tmp) as stack:
  acme=stack.bind('acme')
  globex=stack.bind('globex')
  target='globex-3f2a9c1b-peer'
  rogue=None
  try:
   rogue=FrpsWireSession(stack,{'name':'acme','key':acme['key']},run_id=target)
   accepted=rogue.accepted
   sk=secrets.token_hex(20)
   proxies='\n'.join(['[[proxies]]','name = "globex-3f2a9c1b-data"','type = "stcp"',
                       'secretKey = "'+sk+'"','localIP = "127.0.0.1"',
                       'localPort = '+str(stack.echo_port)])
   legitimate=stack.client('globex',globex['key'],settings='network',client=target,proxies=proxies)
   _wait(lambda:'is already online' in legitimate.log() or 'start proxy success' in legitimate.log(),5)
   blocked='is already online' in legitimate.log()
   print('Foreign legacy login occupied known client ID:',accepted)
   print('Legitimate company client refused as already online:',blocked)
  finally:
   if rogue:rogue.close()
after=hashlib.sha256(source.read_bytes()).hexdigest()
print('Source stable during probe:',before==after)
assert before==after,'source changed during native probe; rerun'
assert not accepted,'foreign binding captured another company client ID through legacy run_id'
assert not blocked,'legitimate company client was blocked by foreign namespace capture'
