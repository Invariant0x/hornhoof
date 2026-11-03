#!/usr/bin/env python3
"""Hornhoof relay: hands out <name>.hornhoof.org links and checks every tunnel that frps lets in.

Public API (Caddy sends https://hornhoof.org/api/* here):
  GET    /api/v1/names/{name}      -> 200 {name, free, reason?: taken|reserved|invalid}
  POST   /api/v1/bindings          {name?} -> 201 {name, url, key, tunnel}
  DELETE /api/v1/bindings/{name}   Authorization: Bearer <key> -> 204
frps plugin (local only): POST /frp/handler?op=Login|NewProxy|Ping
Admin (as the service user): relay.py admin list|show|ban|unban|release|banned-caddy ...

Standard library only. State: SQLite in /var/lib/hornhoof-relay/relay.db. Keys are stored as SHA-256 hashes.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOMAIN = 'hornhoof.org'
DB_PATH = os.environ.get('RELAY_DB', '/var/lib/hornhoof-relay/relay.db')
CADDYFILE = os.environ.get('RELAY_CADDYFILE', '/etc/caddy/Caddyfile')
LISTEN = ('127.0.0.1', int(os.environ.get('RELAY_PORT', '7600')))
FRPC_IMAGE = 'fatedier/frpc:v0.71.1@sha256:7a0a18bc9c83dc106a7e5213a890f521affdf90d595829c56b0ed8481377d50e'
FRPC_CONFIG_PATH = '/etc/frp/frpc.toml'
TARGET_HOST, TARGET_PORT = 'app', 8080

# Bindings per client address per hour, and for everyone together; name checks per address per minute.
BIND_PER_IP_HOUR = 5
BIND_ALL_HOUR = 300
CHECKS_PER_IP_MINUTE = 60
BAD_KEYS_PER_IP_HOUR = 30
MAX_BODY = 4096

LABEL = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'


def now() -> int:
    return int(time.time())


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


_local = threading.local()


def db() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=10000')
        _local.conn = conn
    return conn


def init_db() -> None:
    db().executescript('''
        CREATE TABLE IF NOT EXISTS bindings (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            created_ip TEXT,
            last_seen INTEGER,
            banned_at INTEGER,
            ban_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS creations (ip TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS creations_at ON creations(at);
    ''')


_reserved = {'mtime': None, 'names': frozenset()}


def reserved_names() -> frozenset:
    """The names on the Caddyfile's @reserved line, reread when the file changes."""
    try:
        mtime = os.stat(CADDYFILE).st_mtime
    except OSError:
        return _reserved['names']
    if mtime != _reserved['mtime']:
        names = set()
        with open(CADDYFILE) as f:
            for line in f:
                parts = line.split()
                if parts[:2] == ['@reserved', 'host']:
                    names.update(h[: -len('.' + DOMAIN)] for h in parts[2:] if h.endswith('.' + DOMAIN))
        _reserved.update(mtime=mtime, names=frozenset(names))
    return _reserved['names']


def check_name(name: str):
    """None when the name can be bound, else 'invalid', 'reserved' or 'taken'. A banned name counts as reserved."""
    if not LABEL.match(name) or name[2:4] == '--':
        return 'invalid'
    if name in reserved_names():
        return 'reserved'
    row = db().execute('SELECT banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
    if row is None:
        return None
    return 'reserved' if row[0] else 'taken'


class Window:
    """Counts events per key in a sliding window, in memory."""

    def __init__(self, limit: int, seconds: int):
        self.limit, self.seconds, self.hits, self.lock = limit, seconds, {}, threading.Lock()

    def allow(self, key: str) -> int:
        """0 if allowed (and counted), else seconds to wait."""
        t = time.time()
        with self.lock:
            if len(self.hits) > 50000:
                self.hits = {k: v for k, v in self.hits.items() if v and v[-1] > t - self.seconds}
            recent = [x for x in self.hits.get(key, []) if x > t - self.seconds]
            if len(recent) >= self.limit:
                self.hits[key] = recent
                return int(recent[0] + self.seconds - t) + 1
            recent.append(t)
            self.hits[key] = recent
            return 0


name_checks = Window(CHECKS_PER_IP_MINUTE, 60)
bad_keys = Window(BAD_KEYS_PER_IP_HOUR, 3600)
create_lock = threading.Lock()


def frpc_config(name: str, key: str) -> str:
    return f'''# Hornhoof relay tunnel for https://{name}.{DOMAIN}
# Keep this file secret: it holds the key of the binding.
serverAddr = "{DOMAIN}"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
metadatas.name = "{name}"
metadatas.key = "{key}"

[[proxies]]
name = "{name}"
type = "http"
subdomain = "{name}"
localIP = "{TARGET_HOST}"
localPort = {TARGET_PORT}
# frps speaks plain http to the tunnel; the visitor came over https.
requestHeaders.set.x-forwarded-proto = "https"
'''


def tunnel_info(name: str, key: str) -> dict:
    return {
        'image': FRPC_IMAGE,
        'configPath': FRPC_CONFIG_PATH,
        'args': ['-c', FRPC_CONFIG_PATH],
        'config': frpc_config(name, key),
        'serverAddr': DOMAIN,
        'serverPort': 443,
        'protocol': 'wss',
        'proxyName': name,
        'subdomain': name,
        'target': f'{TARGET_HOST}:{TARGET_PORT}',
    }


def binding_ok(name: str, key: str):
    """None if the name exists, is not banned and the key matches, else a reason."""
    if not isinstance(name, str) or not isinstance(key, str) or not name or not key:
        return 'this tunnel has no Hornhoof relay binding (metadatas.name and metadatas.key)'
    row = db().execute('SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
    if row is None or not hmac.compare_digest(row[0], key_hash(key)):
        return f'no binding {name} with this key'
    if row[1]:
        return f'{name}.{DOMAIN} is blocked'
    return None


_seen = {}


def touch(name: str) -> None:
    t = now()
    if t - _seen.get(name, 0) > 600:
        _seen[name] = t
        db().execute('UPDATE bindings SET last_seen = ? WHERE name = ?', (t, name))


def plugin(op: str, content: dict) -> dict:
    if op == 'Login':
        metas = content.get('metas') or {}
    else:
        metas = (content.get('user') or {}).get('metas') or {}
    name, key = metas.get('name'), metas.get('key')
    reason = binding_ok(name, key)
    if reason is None and op == 'NewProxy':
        user = (content.get('user') or {}).get('user') or ''
        if user:
            reason = 'set no user in the tunnel config'
        elif content.get('proxy_type') != 'http':
            reason = 'only http proxies are allowed'
        elif content.get('proxy_name') != name:
            reason = f'the proxy must be named {name}'
        elif content.get('subdomain') != name:
            reason = f'this key serves only {name}.{DOMAIN}'
        elif content.get('custom_domains'):
            reason = 'custom domains are not allowed'
    if reason is not None:
        return {'reject': True, 'reject_reason': reason}
    touch(name)
    return {'reject': False, 'unchange': True}


class Handler(BaseHTTPRequestHandler):
    server_version = 'hornhoof-relay'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def client_ip(self) -> str:
        fwd = self.headers.get('X-Forwarded-For')
        return fwd.split(',')[0].strip() if fwd else self.client_address[0]

    def send_json(self, status: int, body=None, headers=None) -> None:
        data = b'' if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def error(self, status: int, code: str, message: str, headers=None) -> None:
        self.send_json(status, {'error': code, 'message': message}, headers)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY:
            raise ValueError('body too large')
        raw = self.rfile.read(length) if length else b''
        return json.loads(raw) if raw.strip() else {}

    def path_parts(self):
        return [p for p in self.path.split('?', 1)[0].split('/') if p]

    def do_GET(self):
        parts = self.path_parts()
        if parts[:3] == ['api', 'v1', 'names'] and len(parts) == 4:
            wait = name_checks.allow(self.client_ip())
            if wait:
                return self.error(429, 'rate_limited', 'Too many checks, try again later.', {'Retry-After': str(wait)})
            name = parts[3].lower()
            reason = check_name(name)
            body = {'name': name, 'free': reason is None}
            if reason:
                body['reason'] = reason
            return self.send_json(200, body)
        if parts == ['api', 'v1', 'health']:
            return self.send_json(200, {'ok': True})
        self.error(404, 'not_found', 'Not found.')

    def do_POST(self):
        parts = self.path_parts()
        if parts == ['frp', 'handler']:
            # frps only: Caddy never routes /frp/ here and always adds X-Forwarded-For.
            if self.headers.get('X-Forwarded-For') or self.client_address[0] != '127.0.0.1':
                return self.error(403, 'forbidden', 'Forbidden.')
            try:
                req = self.read_json()
                return self.send_json(200, plugin(req.get('op', ''), req.get('content') or {}))
            except Exception as e:  # never let a bad plugin call through
                return self.send_json(200, {'reject': True, 'reject_reason': f'relay error: {type(e).__name__}'})
        if parts == ['api', 'v1', 'bindings']:
            return self.create_binding()
        self.error(404, 'not_found', 'Not found.')

    def create_binding(self):
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() != 'application/json':
            return self.error(415, 'unsupported_media_type', 'Send the body as application/json.')
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError):
            return self.error(400, 'invalid', 'The body is not valid JSON.')
        if not isinstance(body, dict):
            return self.error(400, 'invalid', 'The body must be a JSON object.')
        name = body.get('name')
        if name is not None and (not isinstance(name, str) or name == ''):
            return self.error(400, 'invalid', 'name must be a non-empty string, or left out for a random one.')
        ip = self.client_ip()
        with create_lock:
            t = now()
            conn = db()
            conn.execute('DELETE FROM creations WHERE at < ?', (t - 3600,))
            mine = conn.execute('SELECT COUNT(*), MIN(at) FROM creations WHERE ip = ?', (ip,)).fetchone()
            total = conn.execute('SELECT COUNT(*) FROM creations').fetchone()[0]
            if mine[0] >= BIND_PER_IP_HOUR or total >= BIND_ALL_HOUR:
                wait = (mine[1] + 3600 - t) if mine[0] >= BIND_PER_IP_HOUR else 600
                return self.error(429, 'rate_limited', 'Too many new links from this address, try again later.',
                                  {'Retry-After': str(max(wait, 1))})
            if name is None:
                while True:
                    name = ''.join(secrets.choice(RANDOM_ALPHABET) for _ in range(24))
                    if check_name(name) is None:
                        break
            else:
                name = name.lower()
                reason = check_name(name)
                if reason == 'invalid':
                    return self.error(400, 'invalid', 'Use lowercase letters, digits and hyphens, 1-63 characters, '
                                                      'no hyphen at either end and none in the 3rd and 4th place.')
                if reason:
                    return self.error(409, reason, f'{name}.{DOMAIN} is {reason}.')
            key = secrets.token_urlsafe(32)
            conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                         (name, key_hash(key), t, ip))
            conn.execute('INSERT INTO creations (ip, at) VALUES (?, ?)', (ip, t))
        print(f'bound {name} for {ip}', flush=True)
        self.send_json(201, {'name': name, 'url': f'https://{name}.{DOMAIN}', 'key': key,
                             'tunnel': tunnel_info(name, key)})

    def do_DELETE(self):
        parts = self.path_parts()
        if not (parts[:3] == ['api', 'v1', 'bindings'] and len(parts) == 4):
            return self.error(404, 'not_found', 'Not found.')
        name = parts[3].lower()
        ip = self.client_ip()
        auth = self.headers.get('Authorization') or ''
        key = auth[7:].strip() if auth.lower().startswith('bearer ') else ''
        row = db().execute('SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
        if row is None:
            return self.error(404, 'not_found', f'There is no binding {name}.')
        if not key or not hmac.compare_digest(row[0], key_hash(key)):
            wait = bad_keys.allow(ip)
            if wait:
                return self.error(429, 'rate_limited', 'Too many wrong keys, try again later.', {'Retry-After': str(wait)})
            return self.error(401, 'unauthorized', 'Send the binding key as Authorization: Bearer <key>.')
        if row[1]:
            return self.error(403, 'blocked', f'{name}.{DOMAIN} is blocked and cannot be released.')
        db().execute('DELETE FROM bindings WHERE name = ?', (name,))
        print(f'released {name} for {ip}', flush=True)
        self.send_json(204)


def admin(args) -> int:
    init_db()
    conn = db()
    cmd = args[0] if args else 'list'
    if cmd == 'list':
        for r in conn.execute('SELECT name, created_at, created_ip, last_seen, banned_at, ban_reason FROM bindings '
                              'ORDER BY created_at'):
            seen = time.strftime('%Y-%m-%d %H:%M', time.gmtime(r[3])) if r[3] else 'never'
            ban = f'  BLOCKED: {r[5]}' if r[4] else ''
            print(f'{r[0]}  created {time.strftime("%Y-%m-%d %H:%M", time.gmtime(r[1]))} from {r[2]}  seen {seen}{ban}')
        return 0
    if cmd == 'banned-caddy':
        hosts = [f'{r[0]}.{DOMAIN}' for r in conn.execute('SELECT name FROM bindings WHERE banned_at IS NOT NULL')]
        print('# Generated by hornhoof-relay from blocked bindings. Do not edit.')
        if hosts:
            print(f'@blocked host {" ".join(hosts)}\nhandle @blocked {{\n\troot * /var/www/hornhoof-pages\n\trewrite * /410.html\n'
                  f'\tfile_server {{\n\t\tstatus 410\n\t}}\n}}')
        return 0
    if cmd == 'add' and len(args) == 2:
        # Operator-made binding, no rate limit. Prints {name, key} as JSON once; keep it secret.
        name = args[1].lower()
        reason = check_name(name)
        if reason:
            print(f'{name}: {reason}', file=sys.stderr)
            return 1
        key = secrets.token_urlsafe(32)
        conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                     (name, key_hash(key), now(), 'operator'))
        print(json.dumps({'name': name, 'key': key}))
        return 0
    if cmd in ('ban', 'unban', 'release') and len(args) >= 2:
        name = args[1].lower()
        if cmd == 'ban':
            reason = ' '.join(args[2:]) or 'blocked by the relay operator'
            if conn.execute('SELECT 1 FROM bindings WHERE name = ?', (name,)).fetchone():
                conn.execute('UPDATE bindings SET banned_at = ?, ban_reason = ? WHERE name = ?', (now(), reason, name))
            else:  # block a name nobody holds, so nobody can take it
                conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip, banned_at, ban_reason) '
                             'VALUES (?, ?, ?, ?, ?, ?)', (name, '-', now(), 'operator', now(), reason))
        elif cmd == 'unban':
            conn.execute('UPDATE bindings SET banned_at = NULL, ban_reason = NULL WHERE name = ?', (name,))
            conn.execute("DELETE FROM bindings WHERE name = ? AND key_hash = '-'", (name,))
        else:
            conn.execute('DELETE FROM bindings WHERE name = ?', (name,))
        print(f'{cmd} {name}: done')
        return 0
    print('usage: relay.py admin list | add <name> | ban <name> [reason] | unban <name> | release <name> | banned-caddy',
          file=sys.stderr)
    return 2


def main() -> int:
    if sys.argv[1:2] == ['admin']:
        return admin(sys.argv[2:])
    init_db()
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    print(f'hornhoof-relay listening on {LISTEN[0]}:{LISTEN[1]}', flush=True)
    server.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
