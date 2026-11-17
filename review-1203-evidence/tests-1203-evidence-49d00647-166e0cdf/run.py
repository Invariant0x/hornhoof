import subprocess,sys,pathlib,json,time
out=pathlib.Path('/tmp/test-1203/local');name=sys.argv[1];cmd=sys.argv[2:]
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();start=time.monotonic()
with (out/(name+'.log')).open('w') as log:
 log.write(json.dumps({'command':cmd,'cwd':str(pathlib.Path.cwd()),'commit':sha})+'\n');log.flush()
 p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 for line in p.stdout:
  log.write(line);log.flush();sys.stdout.write(line);sys.stdout.flush()
 code=p.wait()
meta={'command':cmd,'cwd':str(pathlib.Path.cwd()),'commit':sha,'endCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'exitCode':code,'seconds':round(time.monotonic()-start,3)}
with (out/(name+'.log')).open('a') as log: log.write('\n'+json.dumps(meta)+'\n')
(out/(name+'.json')).write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta),flush=True);sys.exit(code)
