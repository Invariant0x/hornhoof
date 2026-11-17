import json,sys,subprocess
from pathlib import Path
group=sys.argv[1]
files=json.loads(Path('/tmp/test-1203/local/lint-scope.json').read_text())['groups'][group]
cmd=['python3','/tmp/test-1203/run.py','lint-'+group.replace('/','-'),'env','NODE_OPTIONS=--max-old-space-size=2048','npx','--no-install','eslint',*files]
sys.exit(subprocess.call(cmd))
