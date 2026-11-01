"""Use installed tools without adding packages or executing product/native code."""
from datetime import datetime,timezone
import json
from pathlib import Path
import re
import subprocess

BASE=Path(__file__).resolve().parent
SOURCE=BASE/'source'
ROOT=BASE/'quality'
ROOT.mkdir(exist_ok=True)
paths=subprocess.run(['git','diff','--name-only','--diff-filter=d','bd696b0724385b6b11da53a24ada2f188b031217...HEAD'],cwd=SOURCE,capture_output=True,text=True,check=True).stdout.splitlines()
assert len(paths)==29
selected=[str(SOURCE/path) for path in paths]+[str(BASE/'evidence/design-fence.mts'),str(BASE/'evidence/design-fence.test.mts')]
commands=[['crapper','--root',str(ROOT),'--no-coverage',*selected],['dryer','--root',str(ROOT),'--threshold','0.8',*selected]]
receipts=[]
for argv in commands:
    start=datetime.now(timezone.utc).isoformat()
    result=subprocess.run(argv,cwd=SOURCE,capture_output=True,text=True)
    record=dict(argv=argv,cwd=str(SOURCE),startedAt=start,endedAt=datetime.now(timezone.utc).isoformat(),exit=result.returncode,stdout=result.stdout,stderr=result.stderr)
    receipts.append(record)
    (BASE/'quality-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
    (BASE/f'{argv[0]}.log').write_text(result.stdout+result.stderr)
    print(argv[0],'exit',result.returncode)
    if argv[0]=='crapper':
        rows=[m.groups() for m in re.finditer(r'^(\S+)\s+(\S+)\s+(\d+)\s+N/A\s+N/A\s*$',result.stdout,re.M)]
        assert rows
        print('METRIC_ROWS',len(rows),'MAX_CC_ALL_SOURCE',max(int(row[2]) for row in rows),'Cov/CRAP=N/A')
        print('READER_AND_DESIGN',[row for row in rows if 'native-reader' in row[1] or 'native-records' in row[1] or 'design-fence' in row[1]])
    else:print(result.stdout,end='')
    print(result.stderr,end='')
    assert result.returncode==0
print('QUALITY_READ_ONLY_COMPLETE: no coverage/full/mutation qualification')
