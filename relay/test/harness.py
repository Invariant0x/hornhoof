"""Local frp processes and an isolated relay, using only the standard library."""

import base64
from contextlib import ExitStack
import functools
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time


ROOT = Path(__file__).resolve().parents[2]
BIN = Path(__file__).resolve().parent / '.bin'


@functools.lru_cache(maxsize=1)
def _ensure_frp():
    subprocess.run(['sh', str(BIN.parent / 'frp.sh')], cwd=ROOT, check=True, timeout=180)


def _request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def _wait(predicate, within):
    deadline = time.monotonic() + within
    while True:
        if predicate():
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))


class _Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({'host': self.headers.get('Host'), 'path': self.path}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_POST = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET
    do_HEAD = do_GET
    do_OPTIONS = do_GET

    def log_message(self, fmt, *args):
        pass


class _Process:
    def __init__(self, command, log_path, *, env=None, private=()):
        self.log_path = Path(log_path)
        self.private = private
        self.output = self.log_path.open('wb')
        try:
            self.process = subprocess.Popen(
                command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=self.output, stderr=subprocess.STDOUT,
            )
        except BaseException:
            self.output.close()
            raise

    def log(self) -> str:
        text = self.log_path.read_text(encoding='utf-8', errors='replace')
        for value in self.private:
            if value:
                text = text.replace(value, '[hidden]')
        return text

    def resume(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGCONT)

    def pause(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGSTOP)

    def _finish(self, *, kill):
        try:
            if self.process.poll() is None:
                self.resume()
                if kill:
                    self.process.kill()
                else:
                    self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            else:
                self.process.wait()
        finally:
            self.output.close()

    def stop(self):
        self._finish(kill=False)

    def kill(self):
        self._finish(kill=True)


class Client(_Process):
    def started(self, proxy: str, within: float = 15) -> bool:
        pattern = re.compile(r'\[' + re.escape(proxy) + r'\]\s+start proxy success\b')

        def ready():
            return pattern.search(self.log()) is not None or self.process.poll() is not None

        _wait(ready, within)
        return pattern.search(self.log()) is not None


class Stack:
    def __init__(self, tmp: str, dashboard: bool = True):
        self.tmp = Path(tmp)
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.dashboard = dashboard
        self.clients = []
        self.relay = None
        self.frps = None
        self.echo = None
        self.echo_thread = None
        self.password = secrets.token_hex(24)
        self.private = [self.password]
        self._ports = set()
        self.relay_port = self._free_port()
        self.bind_port = self._free_port()
        self.vhost_port = self._free_port()
        self.dash_port = self._free_port()
        self.api_port = self.dash_port if dashboard else self._free_port()
        self.env = dict(os.environ, **{
            'RELAY_DB': str(self.tmp / 'relay.db'),
            'RELAY_PORT': str(self.relay_port),
            'RELAY_CADDYFILE': str(self.tmp / 'Caddyfile'),
            'RELAY_TRACE': '1',
            'RELAY_FRPS_API': f'http://127.0.0.1:{self.api_port}',
            'RELAY_FRPS_USER': 'admin',
            'RELAY_FRPS_PASSWORD': self.password,
            'RELAY_FRPS_BIND': f'127.0.0.1:{self.bind_port}',
            'RELAY_FRPS_STARTED': str(self.tmp / 'frps-started'),
        })

    def _free_port(self):
        while True:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            if port not in self._ports:
                self._ports.add(port)
                return port

    def __enter__(self):
        try:
            _ensure_frp()
            (self.tmp / 'Caddyfile').write_text('@reserved host www.hornhoof.org\n')
            self.echo = ThreadingHTTPServer(('127.0.0.1', 0), _Echo)
            self.echo.daemon_threads = True
            self.echo_port = self.echo.server_port
            self.echo_thread = threading.Thread(target=self.echo.serve_forever, daemon=True)
            self.echo_thread.start()
            self._start_relay()
            self.start_frps()
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self):
        # ExitStack runs every cleanup even if one process fails to stop.
        with ExitStack() as cleanup:
            if self.echo is not None:
                cleanup.callback(self.echo.server_close)
                if self.echo_thread is not None and self.echo_thread.ident is not None:
                    cleanup.callback(self.echo_thread.join, timeout=5)
                    cleanup.callback(self.echo.shutdown)
            if self.relay is not None:
                cleanup.callback(self.relay.stop)
            if self.frps is not None:
                cleanup.callback(self.frps.stop)
            for client in self.clients:
                cleanup.callback(client.stop)

    def _ready(self, process, port, path):
        def ready():
            if process.process.poll() is not None:
                raise RuntimeError('Local process exited during startup:\n' + process.log())
            try:
                status, _ = _request(port, 'GET', path)
                return status == 200
            except (OSError, http.client.HTTPException):
                return False

        if not _wait(ready, 15):
            raise RuntimeError('Local process did not become ready:\n' + process.log())

    def _start_relay(self):
        self.relay = _Process(
            [sys.executable, '-u', str(ROOT / 'relay/relay.py')], self.tmp / 'relay.log',
            env=self.env, private=self.private,
        )
        # Readiness must work before frps starts, including when health later returns 503.
        self._ready(self.relay, self.relay_port, '/api/v1/names/www')

    def restart_relay(self):
        self.relay.stop()
        self._start_relay()

    def start_frps(self):
        if self.frps is not None and self.frps.process.poll() is None:
            return
        replacements = {
            'bindPort': str(self.bind_port),
            'vhostHTTPPort': str(self.vhost_port),
            'webServer.port': str(self.dash_port),
            'addr': json.dumps(f'127.0.0.1:{self.relay_port}'),
        }
        lines = []
        for line in (ROOT / 'relay/frps.toml').read_text().splitlines():
            key = line.split('=', 1)[0].strip()
            if key == 'custom404Page':
                continue
            if key in replacements:
                line = f'{key} = {replacements[key]}'
            lines.append(line.replace('@WEB_PASSWORD@', self.password))
        config_path = self.tmp / 'frps.toml'
        self._write_config(config_path, '\n'.join(lines) + '\n')
        Path(self.env['RELAY_FRPS_STARTED']).write_text(str(int(time.time())))
        self.frps = _Process(
            [str(BIN / 'frps'), '-c', str(config_path)], self.tmp / 'frps.log',
            private=self.private,
        )
        self._ready(self.frps, self.dash_port, '/healthz')

    def stop_frps(self):
        if self.frps is not None:
            self.frps.stop()

    def restart_frps(self):
        self.stop_frps()
        self.start_frps()

    @staticmethod
    def _write_config(path, text):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(text)

    def bind(self, name: str | None = None) -> dict:
        status, body = self.api('POST', '/api/v1/bindings', {} if name is None else {'name': name})
        if status != 201 or not isinstance(body, dict):
            raise AssertionError(f'Binding failed with HTTP {status}')
        self.private.append(body['key'])
        return body

    def client(self, name: str, key: str | None, *, settings: str = 'today',
               client: str | None = None, proxies: str | None = None,
               visitor_key: str | None = None) -> Client:
        if settings not in {'today', 'network'}:
            raise ValueError('Unknown client settings')
        config = [
            'serverAddr = "127.0.0.1"', f'serverPort = {self.bind_port}',
            'loginFailExit = false', 'log.to = "console"', 'log.level = "info"',
            'log.disablePrintColor = true', 'transport.protocol = "websocket"',
        ]
        if settings == 'today':
            config.extend(['transport.heartbeatInterval = 30', 'transport.heartbeatTimeout = 90'])
        else:
            config.extend(['transport.heartbeatInterval = -1', 'transport.tcpMuxKeepaliveInterval = 10'])
        if client is not None:
            config.extend([f'clientID = {json.dumps(client)}', f'metadatas.client = {json.dumps(client)}'])
        config.append(f'metadatas.name = {json.dumps(name)}')
        if key is not None:
            config.append(f'metadatas.key = {json.dumps(key)}')
            self.private.append(key)
        if visitor_key is not None:
            config.append(f'metadatas.visitor = {json.dumps(visitor_key)}')
            self.private.append(visitor_key)
        if proxies is None:
            proxies = f'''
[[proxies]]
name = {json.dumps(name)}
type = "http"
subdomain = {json.dumps(name)}
localIP = "127.0.0.1"
localPort = {self.echo_port}
requestHeaders.set.x-forwarded-proto = "https"
'''
        config.append(proxies)
        number = len(self.clients)
        config_path = self.tmp / f'frpc-{number}.toml'
        self._write_config(config_path, '\n'.join(config) + '\n')
        process = Client(
            [str(BIN / 'frpc'), '-c', str(config_path)], self.tmp / f'frpc-{number}.log',
            private=self.private,
        )
        self.clients.append(process)
        return process

    def get(self, host: str, path: str = '/') -> int:
        status, _ = _request(self.vhost_port, 'GET', path, headers={'Host': host})
        return status

    def api(self, method: str, path: str, body: dict | None = None,
            key: str | None = None) -> tuple[int, dict | None]:
        headers = {}
        if key is not None:
            headers['Authorization'] = f'Bearer {key}'
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        status, data = _request(self.relay_port, method, path, payload, headers)
        return status, json.loads(data) if data else None

    def dash(self, path: str) -> tuple[int, object]:
        auth = base64.b64encode(f'admin:{self.password}'.encode()).decode()
        status, data = _request(self.dash_port, 'GET', path, headers={'Authorization': f'Basic {auth}'})
        if not data:
            return status, None
        try:
            return status, json.loads(data)
        except ValueError:
            return status, data.decode('utf-8', errors='replace')

    def plugin_calls(self) -> list[dict]:
        calls = []
        for line in self.relay.log().splitlines():
            try:
                value = json.loads(line.removeprefix('TRACE '))
            except ValueError:
                continue
            if isinstance(value, dict) and 'op' in value:
                calls.append(value)
        return calls
