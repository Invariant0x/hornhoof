#!/usr/bin/env python3
"""Hornhoof relay: hands out <name>.hornhoof.org links and checks every tunnel that frps lets in.

Public API (Caddy sends https://hornhoof.org/api/* here):
  GET    /api/v1/names/{name}      -> 200 {name, free, reason?: taken|reserved|invalid}
  POST   /api/v1/bindings          {name?} -> 201 {name, url, key, tunnel}
  DELETE /api/v1/bindings/{name}   Authorization: Bearer <key> -> 204
  GET    /api/v1/links/{name}/route Authorization: Bearer <key> -> 200 {state, client, since, generation, ...}
  GET    /api/v1/health            -> 200 {ok, frps, relayStarted} while frps takes logins, else 503
frps plugin (local only): POST /frp/handler?op=Login|NewProxy|Ping
Admin (as the service user): relay.py admin list|show|ban|unban|release|banned-caddy ...

Standard library only. State: SQLite in /var/lib/hornhoof-relay/relay.db. Keys are stored as SHA-256 hashes.
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

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

# frps's dashboard API (loopback only): the one source for whether a route is live.
RELAY_FRPS_API = os.environ.get('RELAY_FRPS_API', 'http://127.0.0.1:7500')
FRPS_USER = os.environ.get('RELAY_FRPS_USER', 'admin')
FRPS_PASSWORD = os.environ.get('RELAY_FRPS_PASSWORD', '')
# The watcher probes these to know whether frps takes logins (R4.1); systemd's ExecStartPost
# rewrites the started file every time frps starts.
RELAY_FRPS_BIND = os.environ.get('RELAY_FRPS_BIND', '127.0.0.1:7000')
RELAY_FRPS_STARTED = os.environ.get('RELAY_FRPS_STARTED', '/run/frps/started')
# A registration frps has not shown yet reads as held for this long (R1.1, R2.1).
PENDING_S = 10
# R3.1 measured with frp 0.71.1: network 20.16/20.46 s, today 20.26 s (2026-11-03).
EVICTION_BOUND_S = 30
# One budget per plugin call: a spent budget refuses the op, fail closed (Review Focus 3).
PLUGIN_CALL_S = 1.0

LABEL = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'


def now() -> int:
    return int(time.time())


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


_local = threading.local()
# One deadline per plugin call: the lock and every dashboard read draw from the time left.
call_state = threading.local()


def call_deadline() -> float | None:
    """Seconds left in the current plugin call's budget; None outside plugin calls."""
    end = getattr(call_state, 'end', None)
    return None if end is None else max(0.0, end - time.monotonic())


def db() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=10000')
        _local.conn = conn
    return conn


def init_db() -> None:
    write('''CREATE TABLE IF NOT EXISTS bindings (
            name TEXT PRIMARY KEY,
            key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            created_ip TEXT,
            last_seen INTEGER,
            banned_at INTEGER,
            ban_reason TEXT
        )''', ())
    write('CREATE TABLE IF NOT EXISTS creations (ip TEXT NOT NULL, at INTEGER NOT NULL)', ())
    write('CREATE INDEX IF NOT EXISTS creations_at ON creations(at)', ())
    write('''CREATE TABLE IF NOT EXISTS routes (
            name TEXT PRIMARY KEY,
            generation INTEGER NOT NULL,
            client TEXT NOT NULL,
            run_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('http', 'https')),
            state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'empty')),
            since INTEGER NOT NULL
        )''', ())


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


# relayStarted is the latest of: this process's start, the watcher's first frps answer after
# a failure or after start, and the integer in RELAY_FRPS_STARTED (R2.2, R4.1).
STARTED = now()

# frps watcher state: frps_ok_at is the epoch of the last good probe, frps_back_at the epoch
# of the first good probe after a failure or after start (0 until then).
_frps = {'ok_at': 0.0, 'back_at': 0}
WATCH_INTERVAL_S = 0.5
# Health answers 200 only while the watcher's last good probe is younger than this.
HEALTH_MAX_AGE_S = 2.0


def frps_answers() -> bool:
    """True when frps's bind port accepts a connection and its dashboard answers /healthz."""
    host, _, port_text = RELAY_FRPS_BIND.rpartition(':')
    try:
        connection = socket.create_connection((host, int(port_text)), timeout=1)
        connection.close()
    except OSError:
        return False
    try:
        status, _ = _dash_get('/healthz', cap=1.0)
    except FrpsUnknown:
        return False
    return status == 200


def watch_frps() -> None:
    """Probe frps forever; keep the last good answer and the recovery after a failure."""
    was_ok = False
    while True:
        if frps_answers():
            t = time.time()
            if not was_ok:
                _frps['back_at'] = t
            _frps['ok_at'] = t
            was_ok = True
        else:
            was_ok = False
        time.sleep(WATCH_INTERVAL_S)


def frps_ok() -> bool:
    """R4.1: true while the watcher's last frps answer is under HEALTH_MAX_AGE_S old."""
    return time.time() - _frps['ok_at'] < HEALTH_MAX_AGE_S


def frps_started_file() -> int:
    """The integer systemd's ExecStartPost wrote when frps last started, 0 when unreadable."""
    try:
        with open(RELAY_FRPS_STARTED) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 0


def relay_started() -> int:
    """The latest of the relay's start, the frps recovery and frps's own start."""
    return int(max(STARTED, _frps['back_at'], frps_started_file()))


class FrpsUnknown(Exception):
    """frps's dashboard gave no trustworthy answer about a route: read unknown, never empty."""


def _dash_get(path: str, cap: float = 0.5) -> tuple[int, bytes]:
    """One dashboard read with a cap-second timeout; less when the plugin call's budget is nearly spent.

    The watcher's own probes pass cap=1. Any error, timeout or a spent budget is FrpsUnknown.
    """
    parsed = urlsplit(RELAY_FRPS_API)
    host = parsed.hostname or '127.0.0.1'
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    kind = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    left = call_deadline()
    if left is not None and left <= 0:
        raise FrpsUnknown(f'{path}: plugin call budget spent')
    connection = kind(host, port, timeout=cap if left is None else min(cap, left))
    try:
        token = base64.b64encode(f'{FRPS_USER}:{FRPS_PASSWORD}'.encode()).decode()
        connection.request('GET', path, headers={'Authorization': f'Basic {token}'})
        response = connection.getresponse()
        return response.status, response.read()
    except (OSError, http.client.HTTPException) as e:
        raise FrpsUnknown(f'{path}: {type(e).__name__}') from None
    finally:
        connection.close()


def dash_answer(name: str, proxy_type: str) -> tuple[str, str] | None:
    """One proxy type's dashboard record: (status, clientID), None on 404, FrpsUnknown otherwise.

    A record is trusted only with a status of online or offline and a non-empty clientID:
    a missing field reads as unknown, never as empty.
    """
    status, body = _dash_get(f'/api/proxy/{proxy_type}/{name}')
    if status == 404:
        return None
    if status != 200:
        raise FrpsUnknown(f'dashboard answered {status} for {proxy_type} {name}')
    try:
        answer = json.loads(body)
        route_status = answer['status']
        client_id = answer['clientID']
    except (ValueError, KeyError, TypeError):
        raise FrpsUnknown(f'dashboard body for {proxy_type} {name} has no route record') from None
    if route_status not in ('online', 'offline') or not isinstance(client_id, str) or not client_id:
        raise FrpsUnknown(f'dashboard body for {proxy_type} {name} is not a route record')
    return route_status, client_id


def frps_route(name: str) -> tuple[str, str | None, str | None]:
    """frps's own view of a name's route: ('online'|'offline', clientID, type), or ('absent', None, None).

    Both proxy types are read: a name holds one route of either type, and two records is unknown.
    """
    http = dash_answer(name, 'http')
    https = dash_answer(name, 'https')
    if http is not None and https is not None:
        raise FrpsUnknown(f'dashboard shows both http and https routes for {name}')
    for proxy_type, answer in (('http', http), ('https', https)):
        if answer is not None:
            return answer[0], answer[1], proxy_type
    return 'absent', None, None


def check_route_holder(name: str, row, status: str, client_id: str | None, proxy_type: str | None) -> None:
    """An online route must match the relay's own record, else the answer is unknown, never empty (R2.3).

    A missing row means the record was lost while frps holds the route: unknown too.
    """
    if status != 'online':
        return
    matches = (row is not None and proxy_type == row[3]
               and client_id == (row[2] if row[1] == 'legacy' else row[1]))
    if matches:
        return
    log_line(f'route of {name} is online outside the relay record')
    raise FrpsUnknown(f'frps route of {name} does not match the relay record')


class WriteBusy(Exception):
    """A SQLite write could not take the lock within its budget: refuse the op, never guess."""


def write(sql: str, args: tuple) -> None:
    """The one SQLite write of the plugin and the API.

    SQLite itself retries database is locked for the write's budget (0.8 s, or the plugin
    call's time left, whichever is less); past the budget the write raises WriteBusy and a
    plugin call refuses with 'relay error: busy' (Review Focus 3).
    """
    conn = db()
    left = call_deadline()
    if left is not None and left <= 0:
        raise WriteBusy('plugin call budget spent')
    budget = 0.8 if left is None else min(0.8, left)
    conn.execute(f'PRAGMA busy_timeout = {max(0, int(budget * 1000))}')
    try:
        conn.execute(sql, args)
    except sqlite3.OperationalError as e:
        if 'locked' in str(e):
            raise WriteBusy(f'database is locked for {budget:.2f} s') from None
        raise
    finally:
        conn.execute('PRAGMA busy_timeout = 10000')


def straighten_route(name: str, row, status: str, t: int) -> None:
    """Move the row to what frps shows; each UPDATE is guarded by the generation as read, so a row
    rewritten since we read frps keeps its newer registration. The per-name lock is held.

    A pending row younger than PENDING_S is a registration frps has not shown yet: it reads held
    even when frps still shows the previous registration's offline record, because frps keeps that
    record until the new one shows. Only an online record turns it held, age or absence empties it.
    """
    state, generation = row[4], row[0]
    if status == 'online':
        write("UPDATE routes SET state = 'held' WHERE name = ? AND generation = ? "
              "AND state IN ('pending', 'empty')", (name, generation))
    elif state == 'held':
        write("UPDATE routes SET state = 'empty', since = ? WHERE name = ? AND generation = ? "
              "AND state = 'held'", (t, name, generation))
    elif state == 'pending' and t - row[5] > PENDING_S:
        write("UPDATE routes SET state = 'empty', since = ? WHERE name = ? AND generation = ? "
              "AND state = 'pending'", (t, name, generation))


def route_body(name: str, row) -> dict:
    """The R2.1 answer from a routes row; a name with no row is empty at generation 0."""
    if row is None:
        binding = db().execute('SELECT created_at FROM bindings WHERE name = ?', (name,)).fetchone()
        since = binding[0] if binding else None
        state, client, generation = 'empty', None, 0
    else:
        since = row[5]
        state = 'empty' if row[4] == 'empty' else 'held'
        client = row[1] if state == 'held' else None
        generation = row[0]
    return {'state': state, 'client': client, 'since': since, 'generation': generation,
            'relayStarted': relay_started(), 'evictionBound': EVICTION_BOUND_S, 'sync': None}


def locked_route_of(name: str) -> dict:
    """The R2.1 body with the per-name lock already held: the row straightened against frps."""
    status, client_id, proxy_type = frps_route(name)
    row = db().execute('SELECT generation, client, run_id, type, state, since FROM routes WHERE name = ?',
                       (name,)).fetchone()
    if row is not None:
        check_route_holder(name, row, status, client_id, proxy_type)
        try:
            straighten_route(name, row, status, now())
        except sqlite3.Error as e:
            raise FrpsUnknown(f'route store is not writable: {type(e).__name__}') from None
        row = db().execute('SELECT generation, client, run_id, type, state, since FROM routes WHERE name = ?',
                           (name,)).fetchone()
    else:
        check_route_holder(name, None, status, client_id, proxy_type)
    return route_body(name, row)


def route_of(name: str) -> dict:
    """The R2.1 body for a name: the routes row straightened against what frps shows right now.

    The per-name lock serializes every read-and-straighten against registrations.
    """
    with route_lock(name):
        return locked_route_of(name)


_route_locks_guard = threading.Lock()
_route_locks: dict[str, threading.Lock] = {}


def route_lock(name: str) -> threading.Lock:
    with _route_locks_guard:
        lock = _route_locks.get(name)
        if lock is None:
            lock = threading.Lock()
            _route_locks[name] = lock
    return lock


def hold_route_lock(name: str) -> bool:
    """Take the per-name lock within the plugin call's remaining budget; False when the budget ran out."""
    lock = route_lock(name)
    left = call_deadline()
    if left is None:
        lock.acquire()
        return True
    return left > 0 and lock.acquire(timeout=left)


def register_route(name: str, content: dict) -> str | None:
    """Record a registration the plugin let through; a reason when the name cannot be taken (R1.1)."""
    user = content.get('user') or {}
    if not hold_route_lock(name):
        return 'relay error: frps does not answer'
    try:
        return register_locked(name, content, user)
    finally:
        route_lock(name).release()


def register_locked(name: str, content: dict, user: dict) -> str | None:
    """The locked half of register_route: refuse a held name, else record the registration."""
    try:
        held = locked_route_of(name)['state'] == 'held'
    except FrpsUnknown:
        return 'relay error: frps does not answer'
    except WriteBusy:
        return 'relay error: busy'
    if held:
        return f'router config conflict: {name} is held'
    return upsert_route(name, content, user)


def upsert_route(name: str, content: dict, user: dict) -> str | None:
    """Write the pending row for a let-through registration; a refusal when the write cannot land."""
    row = db().execute('SELECT generation FROM routes WHERE name = ?', (name,)).fetchone()
    generation = (row[0] if row else 0) + 1
    metas = user.get('metas') or {}
    try:
        write(
            'INSERT INTO routes (name, generation, client, run_id, type, state, since) VALUES (?, ?, ?, ?, ?, ?, ?) '
            'ON CONFLICT(name) DO UPDATE SET generation = excluded.generation, client = excluded.client, '
            'run_id = excluded.run_id, type = excluded.type, state = excluded.state, since = excluded.since',
            (name, generation, metas.get('client') or 'legacy', user.get('run_id') or '',
             content.get('proxy_type') or 'http', 'pending', now()))
    except WriteBusy:
        return 'relay error: busy'
    except sqlite3.Error:
        return 'relay error: frps does not answer'
    return None


def shared_route_fields(content: dict) -> str | None:
    """R1.2: a name is one company's one route, never shared or split across locations or users."""
    for field in ('locations', 'route_by_http_user', 'group'):
        if content.get(field):
            return f'{field} is not allowed'
    return None


def proxy_check(name: str, content: dict) -> str | None:
    """Today's NewProxy checks, then whether this registration may hold the name; None lets it through."""
    if (content.get('user') or {}).get('user'):
        return 'set no user in the tunnel config'
    if content.get('proxy_type') != 'http':
        return 'only http proxies are allowed'
    if content.get('proxy_name') != name:
        return f'the proxy must be named {name}'
    if content.get('subdomain') != name:
        return f'this key serves only {name}.{DOMAIN}'
    if content.get('custom_domains'):
        return 'custom domains are not allowed'
    reason = shared_route_fields(content)
    if reason is not None:
        return reason
    return register_route(name, content)


def trace_run_id(op: str, content: dict) -> str:
    user = content.get('user') or {}
    run_id = content.get('run_id') if op == 'Login' else user.get('run_id')
    return run_id if isinstance(run_id, str) else ''


def trace_client(op: str, content: dict) -> str:
    user = content.get('user') or {}
    metas = content.get('metas') if op == 'Login' else user.get('metas')
    client = metas.get('client') if isinstance(metas, dict) else None
    return client if isinstance(client, str) and client else 'legacy'


def trace_plugin(op: str, content: dict, result: dict, started: float) -> None:
    """With RELAY_TRACE=1, one JSON line per plugin call: no key, no metas beyond client."""
    if not os.environ.get('RELAY_TRACE'):
        return
    line = {'op': op, 'proxy_name': content.get('proxy_name') or '', 'run_id': trace_run_id(op, content),
            'client': trace_client(op, content), 'ms': round((time.monotonic() - started) * 1000, 1),
            'reject': bool(result.get('reject'))}
    log_line('TRACE ' + json.dumps(line))


_print_lock = threading.Lock()


def log_line(text: str) -> None:
    """One complete line on stdout, written atomically so concurrent relay threads never interleave."""
    with _print_lock:
        sys.stdout.write(text + '\n')
        sys.stdout.flush()


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
    if t - _seen.get(name, 0) <= 600:
        return
    write('UPDATE bindings SET last_seen = ? WHERE name = ?', (t, name))
    _seen[name] = t


def plugin(op: str, content: dict) -> dict:
    """One plugin call gets one 1 s budget; a spent budget refuses the op, fail closed (Review Focus 3)."""
    call_state.end = time.monotonic() + PLUGIN_CALL_S
    try:
        return plugin_decide(op, content)
    except WriteBusy:
        return {'reject': True, 'reject_reason': 'relay error: busy'}
    finally:
        call_state.end = None


def plugin_decide(op: str, content: dict) -> dict:
    if op == 'Login':
        metas = content.get('metas') or {}
    else:
        metas = (content.get('user') or {}).get('metas') or {}
    name, key = metas.get('name'), metas.get('key')
    reason = binding_ok(name, key)
    if reason is None and op == 'NewProxy':
        reason = proxy_check(name, content)
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

    def handle_one_request(self):
        """A busy store answers 503 instead of dropping the connection mid-request."""
        try:
            super().handle_one_request()
        except WriteBusy:
            self.error(503, 'busy', 'The relay store is busy, try again.', {'Retry-After': '1'})

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

    def bearer_key(self) -> str:
        auth = self.headers.get('Authorization') or ''
        return auth[7:].strip() if auth.lower().startswith('bearer ') else ''

    def wrong_key(self, ip: str):
        """The 401 for a bad key, counted like DELETE; 429 once an address passes 30 bad keys in an hour."""
        wait = bad_keys.allow(ip)
        if wait:
            return self.error(429, 'rate_limited', 'Too many wrong keys, try again later.', {'Retry-After': str(wait)})
        return self.error(401, 'unauthorized', 'Send the binding key as Authorization: Bearer <key>.')

    def do_GET(self):
        parts = self.path_parts()
        if parts[:3] == ['api', 'v1', 'names'] and len(parts) == 4:
            return self.name_answer(parts[3].lower())
        if parts[:3] == ['api', 'v1', 'links'] and len(parts) == 5 and parts[4] == 'route':
            return self.route_answer(parts[3].lower())
        if parts == ['api', 'v1', 'health']:
            return self.health_answer()
        self.error(404, 'not_found', 'Not found.')

    def name_answer(self, name: str):
        wait = name_checks.allow(self.client_ip())
        if wait:
            return self.error(429, 'rate_limited', 'Too many checks, try again later.', {'Retry-After': str(wait)})
        reason = check_name(name)
        body = {'name': name, 'free': reason is None}
        if reason:
            body['reason'] = reason
        return self.send_json(200, body)

    def route_answer(self, name: str):
        """GET /api/v1/links/<name>/route: who holds the name (R2.1), never a guess (R2.3)."""
        row = db().execute('SELECT key_hash FROM bindings WHERE name = ?', (name,)).fetchone()
        if row is None:
            return self.error(404, 'not_found', f'There is no binding {name}.')
        key = self.bearer_key()
        if not key or not hmac.compare_digest(row[0], key_hash(key)):
            return self.wrong_key(self.client_ip())
        try:
            return self.send_json(200, route_of(name))
        except (FrpsUnknown, WriteBusy):
            return self.error(503, 'unknown', 'The relay cannot tell whether the route is live.')

    def health_answer(self):
        """GET /api/v1/health (R4.1): 200 only while frps takes logins, else 503; never a guess."""
        if frps_ok():
            return self.send_json(200, {'ok': True, 'frps': True, 'relayStarted': relay_started()})
        return self.send_json(503, {'ok': False, 'frps': False})

    def handle_plugin(self):
        # frps only: Caddy never routes /frp/ here and always adds X-Forwarded-For.
        if self.headers.get('X-Forwarded-For') or self.client_address[0] != '127.0.0.1':
            return self.error(403, 'forbidden', 'Forbidden.')
        op, content, err = self.plugin_request()
        if err is not None:
            return self.send_json(200, {'reject': True, 'reject_reason': err})
        started = time.monotonic()
        try:
            result = plugin(op, content)
        except Exception as e:  # never let a bad plugin call through
            result = {'reject': True, 'reject_reason': f'relay error: {type(e).__name__}'}
        trace_plugin(op, content, result, started)
        return self.send_json(200, result)

    def plugin_request(self) -> tuple[str, dict, str | None]:
        """Parse the plugin body into (op, content, error reason)."""
        try:
            req = self.read_json()
            if not isinstance(req, dict):
                raise TypeError('plugin request is not an object')
            content = req.get('content')
            if not isinstance(content, dict):
                content = {}
            return req.get('op', ''), content, None
        except Exception as e:
            return '', {}, f'relay error: {type(e).__name__}'

    def do_POST(self):
        parts = self.path_parts()
        if parts == ['frp', 'handler']:
            return self.handle_plugin()
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
            write('DELETE FROM creations WHERE at < ?', (t - 3600,))
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
            write('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                  (name, key_hash(key), t, ip))
            write('INSERT INTO creations (ip, at) VALUES (?, ?)', (ip, t))
        log_line(f'bound {name} for {ip}')
        self.send_json(201, {'name': name, 'url': f'https://{name}.{DOMAIN}', 'key': key,
                             'tunnel': tunnel_info(name, key)})

    def do_DELETE(self):
        parts = self.path_parts()
        if not (parts[:3] == ['api', 'v1', 'bindings'] and len(parts) == 4):
            return self.error(404, 'not_found', 'Not found.')
        name = parts[3].lower()
        row = db().execute('SELECT key_hash, banned_at FROM bindings WHERE name = ?', (name,)).fetchone()
        if row is None:
            return self.error(404, 'not_found', f'There is no binding {name}.')
        key = self.bearer_key()
        if not key or not hmac.compare_digest(row[0], key_hash(key)):
            return self.wrong_key(self.client_ip())
        if row[1]:
            return self.error(403, 'blocked', f'{name}.{DOMAIN} is blocked and cannot be released.')
        write('DELETE FROM bindings WHERE name = ?', (name,))
        log_line(f'released {name} for {self.client_ip()}')
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
        write('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
              (name, key_hash(key), now(), 'operator'))
        print(json.dumps({'name': name, 'key': key}))
        return 0
    if cmd in ('ban', 'unban', 'release') and len(args) >= 2:
        name = args[1].lower()
        if cmd == 'ban':
            reason = ' '.join(args[2:]) or 'blocked by the relay operator'
            if conn.execute('SELECT 1 FROM bindings WHERE name = ?', (name,)).fetchone():
                write('UPDATE bindings SET banned_at = ?, ban_reason = ? WHERE name = ?', (now(), reason, name))
            else:  # block a name nobody holds, so nobody can take it
                write('INSERT INTO bindings (name, key_hash, created_at, created_ip, banned_at, ban_reason) '
                      'VALUES (?, ?, ?, ?, ?, ?)', (name, '-', now(), 'operator', now(), reason))
        elif cmd == 'unban':
            write('UPDATE bindings SET banned_at = NULL, ban_reason = NULL WHERE name = ?', (name,))
            write("DELETE FROM bindings WHERE name = ? AND key_hash = '-'", (name,))
        else:
            write('DELETE FROM bindings WHERE name = ?', (name,))
        print(f'{cmd} {name}: done')
        return 0
    print('usage: relay.py admin list | add <name> | ban <name> [reason] | unban <name> | release <name> | banned-caddy',
          file=sys.stderr)
    return 2


def main() -> int:
    if sys.argv[1:2] == ['admin']:
        return admin(sys.argv[2:])
    init_db()
    threading.Thread(target=watch_frps, name='frps-watcher', daemon=True).start()
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    print(f'hornhoof-relay listening on {LISTEN[0]}:{LISTEN[1]}', flush=True)
    server.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
