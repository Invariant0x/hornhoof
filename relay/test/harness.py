"""Local frp processes and an isolated relay, using only the standard library."""

import base64
from collections.abc import Callable
from contextlib import ExitStack, suppress
from dataclasses import dataclass
import functools
import glob
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from typing import NamedTuple


# Not resolve(): a mutator worker symlinks this file, and its own copy of relay.py must be the one that runs.
ROOT = Path(__file__).absolute().parents[2]
BIN = Path(__file__).absolute().parent / '.bin'
PUBLIC_TIMEOUT = 10
CADDY_RELOADED = 'successfully reloaded config from file'
LOST_PORT = re.compile(r'listen tcp [^ ]*:(\d+): bind: address already in use')
SAME_AS_HOST = object()
TEST_CERTIFICATE_CONFIG = """
[req]
distinguished_name = subject
[subject]
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
[leaf]
basicConstraints = critical, CA:FALSE
subjectAltName = DNS:hornhoof.org, DNS:www.hornhoof.org, DNS:*.hornhoof.org
"""


@functools.lru_cache(maxsize=None)
def _ensure_binaries(script: str) -> None:
    subprocess.run(['sh', str(BIN.parent / script)], cwd=ROOT, check=True, timeout=180)


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


def render_caddyfile(text: str, replacements: list[tuple[str, str]]) -> str:
    """Raises on a replacement that finds nothing, so that a Caddyfile change cannot slip past the tests unseen."""
    for old, new in replacements:
        if old not in text:
            raise ValueError(f'The Caddyfile no longer holds: {old!r}')
        text = text.replace(old, new)
    return text


class CertificateFiles(NamedTuple):
    ca: Path
    cert: Path
    key: Path


def _openssl(*args: object, stdin: bytes | None = None) -> bytes:
    return subprocess.run(['openssl', *map(str, args)], input=stdin, check=True, capture_output=True,
                          timeout=30).stdout


def _make_test_certificates(folder: Path) -> CertificateFiles:
    config = folder / 'openssl.cnf'
    config.write_text(TEST_CERTIFICATE_CONFIG)
    ca, ca_key = folder / 'ca.crt', folder / 'ca.key'
    cert, key, request = folder / 'test.crt', folder / 'test.key', folder / 'test.csr'
    _openssl('ecparam', '-genkey', '-name', 'prime256v1', '-noout', '-out', ca_key)
    _openssl('req', '-x509', '-new', '-key', ca_key, '-config', config, '-extensions', 'ca',
             '-subj', '/CN=Hornhoof relay test CA', '-days', 2, '-out', ca)
    _openssl('ecparam', '-genkey', '-name', 'prime256v1', '-noout', '-out', key)
    _openssl('req', '-new', '-key', key, '-config', config, '-subj', '/CN=hornhoof.org', '-out', request)
    _openssl('x509', '-req', '-in', request, '-CA', ca, '-CAkey', ca_key, '-CAcreateserial', '-days', 2,
             '-extfile', config, '-extensions', 'leaf', '-out', cert)
    return CertificateFiles(ca, cert, key)


# A burst of connections shows one certificate over and over, and one process is enough to read it.
@functools.lru_cache(maxsize=16)
def _cached_dns_names(certificate: bytes) -> tuple[str, ...]:
    """ssl parses a peer's certificate only after verifying it, and these connections do not verify."""
    text = _openssl('x509', '-inform', 'DER', '-noout', '-text', stdin=certificate).decode()
    return tuple(re.findall(r'DNS:([^,\s]+)', text))


def _dns_names(certificate: bytes) -> list[str]:
    return list(_cached_dns_names(certificate))


def _tls_socket(port: int, server_name: str | None) -> ssl.SSLSocket:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    plain = socket.create_connection(('127.0.0.1', port), timeout=PUBLIC_TIMEOUT)
    return context.wrap_socket(plain, server_hostname=server_name)


@dataclass(frozen=True)
class Answer:
    status: int | None
    headers: dict[str, str]
    body: bytes
    cert_names: list[str]
    local_port: int
    error: str | None


def _failed(error: Exception, local_port: int = 0) -> Answer:
    return Answer(None, {}, b'', [], local_port, repr(error))


class KeptConnection:
    def __init__(self, sock: socket.socket, host: str, cert_names: list[str]):
        # The address is never dialed, the socket is open already. Without auto_open a closed connection
        # fails instead of quietly dialing a new one, because again() promises the same socket.
        self._connection = http.client.HTTPConnection('127.0.0.1')
        self._connection.sock = sock
        self._connection.auto_open = 0
        self._host = host
        self._cert_names = cert_names
        self._local_port = sock.getsockname()[1]

    def ask(self, path: str, method: str = 'GET', body: bytes = b'') -> Answer:
        try:
            self._connection.request(method, path, body=body or None, headers={'Host': self._host})
            response = self._connection.getresponse()
            return Answer(response.status, dict(response.getheaders()), response.read(), self._cert_names,
                          self._local_port, None)
        except (OSError, http.client.HTTPException) as error:
            return _failed(error, self._local_port)

    def again(self, path: str) -> Answer:
        return self.ask(path)

    def close(self) -> None:
        self._connection.close()


class _Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({'host': self.headers.get('Host'), 'path': self.path,
                           'xff': self.headers.get('X-Forwarded-For')}).encode()
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


def _process_of_socket(inode: str) -> str:
    link = f'socket:[{inode}]'
    for fd in glob.glob('/proc/[0-9]*/fd/*'):
        with suppress(OSError):
            if os.readlink(fd) == link:
                pid = fd.split('/')[2]
                return f'pid {pid} ({Path(f"/proc/{pid}/comm").read_text().strip()})'
    return 'a process this user cannot see'


def _holders_of(port: int) -> list[str]:
    """Who holds a port, from the kernel's tables, on Linux. A process that lost the port cannot say."""
    tables = [Path('/proc/net/tcp'), Path('/proc/net/tcp6')]
    sockets = [line.split() for table in tables if table.exists() for line in table.read_text().splitlines()[1:]]
    return [f'port {port} is held by {_process_of_socket(fields[9])}, TCP state {fields[3]}'
            for fields in sockets if int(fields[1].split(':')[1], 16) == port]


def _startup_failure(process: _Process) -> str:
    log = process.log()
    holders = [holder for port in LOST_PORT.findall(log) for holder in _holders_of(int(port))]
    return '\n'.join(['Local process exited during startup:', log, *holders])


class Client(_Process):
    def started(self, proxy: str, within: float = 15) -> bool:
        pattern = re.compile(r'\[' + re.escape(proxy) + r'\]\s+start proxy success\b')

        def ready():
            return pattern.search(self.log()) is not None or self.process.poll() is not None

        _wait(ready, within)
        return pattern.search(self.log()) is not None


class Stack:
    def __init__(self, tmp: str, dashboard: bool = True, caddy: bool = False):
        self.tmp = Path(tmp)
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.dashboard = dashboard
        self.with_caddy = caddy
        self.clients = []
        self.kept_connections = []
        self.relay = None
        self.frps = None
        self.caddy = None
        self.caddy_folder = self.tmp / 'caddy'
        self.certificates = None
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
        self.http_port = self._free_port()
        self.https_port = self._free_port()
        self.echo_port = self._free_port()
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
            _ensure_binaries('frp.sh')
            (self.tmp / 'Caddyfile').write_text('@reserved host www.hornhoof.org\n')
            # A picked port, not bind(0), which may draw any free port, and the ports picked above stay free until their
            # owners start. A run lost frps to that draw.
            self.echo = ThreadingHTTPServer(('127.0.0.1', self.echo_port), _Echo)
            self.echo.daemon_threads = True
            self.echo_thread = threading.Thread(target=self.echo.serve_forever, daemon=True)
            self.echo_thread.start()
            self._start_relay()
            self.start_frps()
            if self.with_caddy:
                self._start_caddy()
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
            if self.caddy is not None:
                cleanup.callback(self.caddy.stop)
            for client in self.clients:
                cleanup.callback(client.stop)
            for kept in self.kept_connections:
                cleanup.callback(kept.close)

    def _ready(self, process, port, path):
        def answers():
            try:
                status, _ = _request(port, 'GET', path)
                return status == 200
            except (OSError, http.client.HTTPException):
                return False

        self._wait_ready(process, answers)

    @staticmethod
    def _wait_ready(process: _Process, answers: Callable[[], bool]) -> None:
        def ready():
            if process.process.poll() is not None:
                raise RuntimeError(_startup_failure(process))
            return answers()

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

    def _caddy_replacements(self) -> list[tuple[str, str]]:
        folder = self.caddy_folder
        test_tls = f'tls {self.certificates.cert} {self.certificates.key}'
        return [
            # default_bind keeps a test server off this machine's network. auto_https disable_certs makes
            # a site this list missed fail its handshake, where it would otherwise ask for a real certificate.
            ('{\n\tservers {',
             f'{{\n\tadmin off\n\thttp_port {self.http_port}\n\thttps_port {self.https_port}\n'
             '\tdefault_bind 127.0.0.1\n\tauto_https disable_certs\n\tservers {'),
            ('hornhoof.org {\n\t# The relay', f'hornhoof.org {{\n\t{test_tls}\n\t# The relay'),
            ('www.hornhoof.org {\n', f'www.hornhoof.org {{\n\t{test_tls}\n'),
            ('\ttls /etc/caddy/certs/wildcard.crt /etc/caddy/certs/wildcard.key\n', f'\t{test_tls}\n'),
            ('root * /var/www/hornhoof\n', f'root * {folder}/www\n'),
            ('root * /var/www/hornhoof-pages\n', f'root * {folder}/pages\n'),
            ('import blocked.caddy\n', f'import {folder}/blocked.caddy\n'),
            ('import companies/*.caddy\n', f'import {folder}/companies/*.caddy\n'),
            ('reverse_proxy 127.0.0.1:7600\n', f'reverse_proxy 127.0.0.1:{self.relay_port}\n'),
            ('reverse_proxy 127.0.0.1:7000 {', f'reverse_proxy 127.0.0.1:{self.bind_port} {{'),
            ('reverse_proxy 127.0.0.1:8080 {', f'reverse_proxy 127.0.0.1:{self.vhost_port} {{'),
            ('\theader -Server\n', '\theader -Server\n\theader X-Test-Peer {remote_host}:{remote_port}\n'),
        ]

    def _prepare_caddy_folder(self) -> None:
        folder = self.caddy_folder
        (folder / 'companies').mkdir(parents=True)
        (folder / 'companies/none.caddy').write_text('# No company on an SSH tunnel in these tests.\n')
        shutil.copytree(ROOT / 'www', folder / 'www')
        (folder / 'pages').mkdir()
        for page in ('404.html', '410.html'):
            shutil.copy(ROOT / 'relay' / page, folder / 'pages' / page)
        self.certificates = _make_test_certificates(folder)
        rendered = render_caddyfile((ROOT / 'Caddyfile').read_text(), self._caddy_replacements())
        (folder / 'Caddyfile').write_text(rendered)
        self._write_blocked()

    def _write_blocked(self) -> None:
        # relay.py names the droplet's folder of pages, and here the pages live elsewhere.
        blocked = self.admin('banned-caddy').replace('/var/www/hornhoof-pages', f'{self.caddy_folder}/pages')
        (self.caddy_folder / 'blocked.caddy').write_text(blocked)

    def _start_caddy(self) -> None:
        _ensure_binaries('caddy.sh')
        self._prepare_caddy_folder()
        folder = str(self.caddy_folder)
        command = [str(BIN / 'caddy'), 'run', '--config', f'{folder}/Caddyfile', '--adapter', 'caddyfile']
        # Caddy's state stays in this test's folder, never in the home of whoever runs the tests.
        env = dict(os.environ, HOME=folder, XDG_DATA_HOME=f'{folder}/data', XDG_CONFIG_HOME=f'{folder}/config')
        self.caddy = _Process(command, self.tmp / 'caddy.log', env=env, private=self.private)
        self._wait_ready(self.caddy, lambda: self.https('hornhoof.org').status == 200)

    def reload_caddy(self, within: float = PUBLIC_TIMEOUT) -> None:
        self._write_blocked()
        reloads = self.caddy.log().count(CADDY_RELOADED)
        # admin off leaves no admin endpoint for caddy reload. Caddy rereads its file on this signal.
        self.caddy.process.send_signal(signal.SIGUSR1)
        if not _wait(lambda: self.caddy.log().count(CADDY_RELOADED) > reloads, within):
            raise RuntimeError('Caddy did not reload:\n' + self.caddy.log())

    def admin(self, *args: str) -> str:
        command = [sys.executable, str(ROOT / 'relay/relay.py'), 'admin', *args]
        return subprocess.run(command, env=self.env, check=True, capture_output=True, text=True, timeout=30).stdout

    def https(self, host: str, path: str = '/', *, sni: object = SAME_AS_HOST, keep: bool = False,
              method: str = 'GET', body: bytes = b'') -> Answer | tuple[Answer, KeptConnection | None]:
        try:
            sock = _tls_socket(self.https_port, host if sni is SAME_AS_HOST else sni)
        except OSError as error:
            return (_failed(error), None) if keep else _failed(error)
        kept = KeptConnection(sock, host, _dns_names(sock.getpeercert(binary_form=True)))
        answer = kept.ask(path, method, body)
        if keep:
            self.kept_connections.append(kept)
            return answer, kept
        kept.close()
        return answer

    def http(self, host: str, path: str = '/') -> Answer:
        try:
            sock = socket.create_connection(('127.0.0.1', self.http_port), timeout=PUBLIC_TIMEOUT)
        except OSError as error:
            return _failed(error)
        kept = KeptConnection(sock, host, [])
        answer = kept.ask(path)
        kept.close()
        return answer

    def bind(self, name: str | None = None) -> dict:
        status, body = self.api('POST', '/api/v1/bindings', {} if name is None else {'name': name})
        if status != 201 or not isinstance(body, dict):
            raise AssertionError(f'Binding failed with HTTP {status}')
        self.private.append(body['key'])
        return body

    def client(self, name: str, key: str | None, *, settings: str = 'today',
               client: str | None = None, proxies: str | None = None,
               visitor_key: str | None = None, via: str = 'frps') -> Client:
        if settings not in {'today', 'network'}:
            raise ValueError('Unknown client settings')
        config = [
            'serverAddr = "127.0.0.1"', *self._way_in(via),
            'loginFailExit = false', 'log.to = "console"', 'log.level = "info"',
            'log.disablePrintColor = true',
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

    def _way_in(self, via: str) -> list[str]:
        if via == 'frps':
            return [f'serverPort = {self.bind_port}', 'transport.protocol = "websocket"']
        if via == 'caddy':
            # As Hornhoof's frpc does (apps/server/src/modules/link/client.ts), trusting the test CA.
            return [
                f'serverPort = {self.https_port}', 'transport.protocol = "wss"',
                'transport.tls.serverName = "hornhoof.org"',
                f'transport.tls.trustedCaFile = {json.dumps(str(self.certificates.ca))}',
            ]
        raise ValueError('Unknown way in')

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
