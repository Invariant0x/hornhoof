"""Replay only the authorized synthetic negatives and type check; install nothing."""
from datetime import datetime,timezone
import json
from pathlib import Path
import subprocess

BASE=Path(__file__).resolve().parent
EVIDENCE=BASE/'evidence'
TYPES=BASE.parent/'.review-14-r3/source/node_modules'
assert (TYPES/'typescript/bin/tsc').is_file()
assert (TYPES/'@types/node/package.json').is_file()
commands=[('design-tests',['node','--experimental-strip-types','--test','--test-concurrency=1',str(EVIDENCE/'design-fence.test.mts')]),
          ('design-types',['node',str(TYPES/'typescript/bin/tsc'),'-p',str(EVIDENCE/'tsconfig.json'),'--noEmit','--typeRoots',str(TYPES/'@types')])]
receipts=[]
for label,argv in commands:
    started=datetime.now(timezone.utc).isoformat()
    logfile=BASE/f'{label}.log'
    with logfile.open('w') as output:
        process=subprocess.Popen(argv,cwd=EVIDENCE,stdout=output,stderr=subprocess.STDOUT)
        print(label,'START',started,'PID',process.pid,flush=True)
        code=process.wait()
    r=dict(label=label,argv=argv,cwd=str(EVIDENCE),startedAt=started,endedAt=datetime.now(timezone.utc).isoformat(),pid=process.pid,exit=code,log=str(logfile))
    receipts.append(r)
    (BASE/'design-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
    print(label,'EXIT',code,'END',r['endedAt'],flush=True)
    if code:raise SystemExit(code)
print('DESIGN_CHECKS_COMPLETE: read both full logs; SYNTHETIC_ONLY_NOT_NATIVE_QUALIFICATION',flush=True)
