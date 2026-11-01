"""Restore only the current V2 text and exact source bundle from task62."""
import base64
import hashlib
import json
from pathlib import Path
import re

BASE=Path(__file__).resolve().parent
task=json.loads((BASE/'task-initial.json').read_text())
chunks={}
texts={}
for event in task['log']:
    note=event['text']
    bundle=re.match(r'^TASK62_SOURCE_R2_BASE64_PART (\d+)/(\d+)\nBundleSHA256 ([0-9a-f]{64})\n([A-Za-z0-9+/=]+)$',note)
    if bundle:
        index,total,pin,payload=bundle.groups()
        assert int(total)==18 and pin=='eee319c405f1544b0997270499bc5259d6188ef14a361abfcbaf272efe8ce984'
        assert int(index) not in chunks
        chunks[int(index)]=payload
    text=re.match(r'^TASK62_SOURCE_R2_TEXT_V2 ([A-Za-z0-9_.-]+) (\d+)/(\d+)\nFileBytes (\d+) FileSHA256 ([0-9a-f]{64})\n([\s\S]*)\nTASK62_SOURCE_R2_TEXT_END$',note)
    if text:
        name,index,total,size,pin,payload=text.groups()
        item=texts.setdefault(name,dict(total=int(total),size=int(size),sha256=pin,parts={}))
        assert item['total']==int(total) and item['size']==int(size) and item['sha256']==pin
        assert int(index) not in item['parts']
        item['parts'][int(index)]=payload
assert set(chunks)==set(range(1,19))
bundle=base64.b64decode(''.join(chunks[i] for i in range(1,19)),validate=True)
assert len(bundle)==38758
assert hashlib.sha256(bundle).hexdigest()=='eee319c405f1544b0997270499bc5259d6188ef14a361abfcbaf272efe8ce984'
(BASE/'task62-source.bundle').write_bytes(bundle)
out=BASE/'evidence'
out.mkdir(exist_ok=True)
assert set(texts)=={'source-manifest.json','producer-handoff.md','producer-cases.json','design-fence.mts','design-fence.test.mts','tsconfig.json'}
files=[]
for name,item in texts.items():
    assert set(item['parts'])==set(range(1,item['total']+1))
    raw=''.join(item['parts'][i] for i in range(1,item['total']+1)).encode()
    assert len(raw)==item['size'],name
    assert hashlib.sha256(raw).hexdigest()==item['sha256'],name
    (out/name).write_bytes(raw)
    files.append(dict(name=name,bytes=len(raw),sha256=item['sha256'],parts=item['total']))
    print('V2_FILE_VERIFIED',name,len(raw),item['sha256'])
proof=dict(bundleBytes=len(bundle),bundleSha256=hashlib.sha256(bundle).hexdigest(),bundleParts=18,
           textParts=sum(item['total'] for item in texts.values()),files=files,result='REVIEW62_TRANSPORT_VALID')
(BASE/'transport-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print('REVIEW62_TRANSPORT_VALID:18 bundle parts,18 V2 text parts,6 exact files; superseded TEXT ignored')
