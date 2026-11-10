"""Check key-bearing issuance status and lifecycle hash diagnostics safely."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge')
sys.path.insert(0, '/Users/0x/Projects/hornhoof-edge/relay/test')
from test_peers import PeerTests, VisitorKeyLifecycleTests
paths=[Path('/Users/0x/Projects/hornhoof-edge/relay/relay.py'),
       Path('/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py')]
before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
checks=[]
case=PeerTests('test_r6_2_visitor_key')
original=case.visitor_key
status_keys=[]
def wrong_status(*args,**kwargs):
    status,body=original(*args,**kwargs)
    if status==200:
        status_keys.append(body['visitorKey'])
        return 500,body
    return status,body
case.visitor_key=wrong_status
checks.append(('issuance status diagnostic',case,status_keys))
case2=VisitorKeyLifecycleTests('test_http_visitor_key_authorized_before_release_answers_404')
request=case2.api
store_keys=[]
def plaintext_observation(*args,**kwargs):
    status,body=request(*args,**kwargs)
    if status==200 and isinstance(body,dict) and 'visitorKey' in body:
        store_keys.append(body['visitorKey'])
        case2.relay.write('UPDATE visitor_keys SET key_hash = ? WHERE name = ?',
                          (body['visitorKey'],'acme'))
    return status,body
case2.api=plaintext_observation
checks.append(('lifecycle hash diagnostic',case2,store_keys))
results=[]
for label,test,keys in checks:
    capture=io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        result=unittest.TextTestRunner(stream=capture,verbosity=2).run(test)
    leaked=any(key in capture.getvalue() for key in keys)
    print(label,'failures:',len(result.failures),'errors:',len(result.errors),'credential leaked:',leaked)
    results.append(bool(result.failures) and not result.errors and not leaked)
after=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
print('Source/test stable during probe:',before==after)
assert before==after,'source changed during isolated probes; rerun on stable source'
assert all(results),'known key-bearing assertion diagnostics exposed generated credentials'
