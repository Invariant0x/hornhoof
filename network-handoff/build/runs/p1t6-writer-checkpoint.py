"""Pause only our exact Kimi CLI after its active child command has finished."""
import os
import signal
import subprocess
import time
pid=10570

def identity():
    p=subprocess.run(['ps','-p',str(pid),'-o','lstart=,comm='],capture_output=True,text=True)
    return p.stdout.strip()
expected=identity()
assert expected.endswith('Kimi Code'), 'writer PID identity does not match'
print('Waiting for our exact writer PID to finish its active child command.',flush=True)
quiet=0
while True:
    if identity()!=expected:
        print('Writer exited or identity changed; no signal sent.',flush=True)
        break
    rows=subprocess.check_output(['ps','-axo','pid=,ppid='],text=True).splitlines()
    has_child=any(len(parts:=line.split())==2 and int(parts[1])==pid for line in rows)
    quiet=0 if has_child else quiet+1
    if quiet>=3:
        if identity()!=expected:
            print('Writer identity changed; no signal sent.',flush=True)
            break
        os.kill(pid,signal.SIGINT)
        print('Sent SIGINT only to verified writer PID after child command finished.',flush=True)
        break
    time.sleep(0.5)
