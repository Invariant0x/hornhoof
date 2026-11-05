"""A recovering machine's long upload through the relay: one big, slow, chunked PUT to a company in http mode."""

from collections.abc import Callable
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import socket
import ssl
import tempfile
import threading
import time
import unittest

if __package__:
    from .harness import ROOT, Stack
else:
    from harness import ROOT, Stack


CHUNK_SIZE = 1024 * 1024
CHUNKS = 300
TOTAL_SIZE = CHUNK_SIZE * CHUNKS
# Slower than the 60 s of vhostHTTPTimeout, so that a timer on the whole request would cut it.
PACE_SECONDS = 72
MIN_ELAPSED = 65
ANSWER_WAIT = 60
HOST = 'acme.hornhoof.org'
BODY_LIMIT_WORDS = ('request_body', 'max_size', 'read_body')


def chunk_of(number: int) -> bytes:
    """The same bytes on every run, different in every chunk, so that a lost or doubled chunk changes the hash."""
    return number.to_bytes(4, 'big') * (CHUNK_SIZE // 4)


def read_chunked(read_line: Callable[[], bytes], read_exactly: Callable[[int], bytes],
                 consume: Callable[[bytes], None]) -> int:
    """Hands each piece of a chunked body to consume as it comes. Returns the body's size."""
    size = 0
    while True:
        length = int(read_line().split(b';')[0].strip(), 16)
        if length == 0:
            break
        consume(read_exactly(length))
        read_exactly(2)
        size += length
    while read_line().strip():
        pass
    return size


def read_sized(read_exactly: Callable[[int], bytes], length: int, consume: Callable[[bytes], None]) -> int:
    remaining = length
    while remaining:
        piece = read_exactly(min(remaining, CHUNK_SIZE))
        consume(piece)
        remaining -= len(piece)
    return length


class Backend(BaseHTTPRequestHandler):
    """The company's app: reads a whole body as it comes, hashes it and answers with its size and SHA-256."""

    protocol_version = 'HTTP/1.1'

    def do_PUT(self) -> None:
        digest = hashlib.sha256()
        if 'chunked' in self.headers.get('Transfer-Encoding', '').lower():
            size = read_chunked(self.rfile.readline, self.rfile.read, digest.update)
        else:
            size = read_sized(self.rfile.read, int(self.headers.get('Content-Length', '0')), digest.update)
        answer = json.dumps({'size': size, 'sha256': digest.hexdigest()}).encode()
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def log_message(self, fmt, *args) -> None:
        pass


class Upload:
    """What the sender knows: its own size and hash, what it was answered, and how long it took."""

    def __init__(self) -> None:
        self.status: int | None = None
        self.body = b''
        self.sent_size = 0
        self.sent_hash = ''
        self.elapsed = 0.0
        self.send_error: str | None = None


def paced_deadline(start: float, number: int) -> float:
    """When chunk number should leave, so that all of them last PACE_SECONDS."""
    return start + PACE_SECONDS * number / CHUNKS


def send_chunk(sock: ssl.SSLSocket, data: bytes) -> None:
    sock.sendall(f'{len(data):x}\r\n'.encode() + data + b'\r\n')


def read_answer(sock: ssl.SSLSocket) -> tuple[int | None, bytes]:
    """The status and body of the one answer, from a socket the server may have closed after it."""
    sock.settimeout(ANSWER_WAIT)
    received = b''
    try:
        while b'\r\n\r\n' not in received:
            part = sock.recv(65536)
            if not part:
                break
            received += part
        head, _, body = received.partition(b'\r\n\r\n')
        match = re.match(rb'HTTP/1\.[01] (\d{3})', head)
        wanted = re.search(rb'(?im)^content-length:\s*(\d+)', head)
        while wanted and len(body) < int(wanted.group(1)):
            part = sock.recv(65536)
            if not part:
                break
            body += part
    except OSError:
        return None, b''
    return (int(match.group(1)) if match else None), body


def put_big_body(stack: Stack) -> Upload:
    upload = Upload()
    digest = hashlib.sha256()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(str(stack.certificates.ca))
    context.check_hostname = False
    plain = socket.create_connection(('127.0.0.1', stack.https_port), timeout=ANSWER_WAIT)
    with context.wrap_socket(plain, server_hostname=HOST) as sock:
        sock.sendall((f'PUT /bundle HTTP/1.1\r\nHost: {HOST}\r\nTransfer-Encoding: chunked\r\n'
                      'Content-Type: application/octet-stream\r\nConnection: close\r\n\r\n').encode())
        start = time.monotonic()
        try:
            for number in range(CHUNKS):
                time.sleep(max(0.0, paced_deadline(start, number) - time.monotonic()))
                data = chunk_of(number)
                send_chunk(sock, data)
                digest.update(data)
                upload.sent_size += len(data)
            sock.sendall(b'0\r\n\r\n')
        except OSError as error:
            # The relay may have answered and closed already: the answer below says why.
            upload.send_error = repr(error)
        upload.status, upload.body = read_answer(sock)
        upload.elapsed = time.monotonic() - start
    upload.sent_hash = digest.hexdigest()
    return upload


class BigBodyTests(unittest.TestCase):
    def test_long_upload_reaches_the_company(self) -> None:
        backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        backend.daemon_threads = True
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(backend.shutdown)
        self.addCleanup(backend.server_close)
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-edge-'))
        stack = self.enterContext(Stack(tmp, caddy=True))
        binding = stack.bind('acme')
        client = stack.client('acme', binding['key'], via='caddy', proxies=f'''
[[proxies]]
name = "acme"
type = "http"
subdomain = "acme"
localIP = "127.0.0.1"
localPort = {backend.server_port}
''')
        self.assertTrue(client.started('acme'), client.log())

        upload = put_big_body(stack)

        self.assertEqual(upload.status, 201, upload.send_error)
        self.assertEqual(json.loads(upload.body), {'size': TOTAL_SIZE, 'sha256': upload.sent_hash})
        self.assertEqual(upload.sent_size, TOTAL_SIZE)
        self.assertGreaterEqual(upload.elapsed, MIN_ELAPSED)

    def test_chunked_body_is_read_whole(self) -> None:
        wire = iter([b'3\r\n', b'4;ext=1\r\n', b'0\r\n', b'\r\n'])
        pieces = []
        data = iter([b'abc', b'\r\n', b'defg', b'\r\n'])
        size = read_chunked(lambda: next(wire), lambda count: next(data), pieces.append)
        self.assertEqual((size, pieces), (7, [b'abc', b'defg']))

    def test_pace_spreads_chunks_over_the_whole_time(self) -> None:
        self.assertEqual(paced_deadline(10.0, 0), 10.0)
        self.assertEqual(paced_deadline(10.0, CHUNKS), 10.0 + PACE_SECONDS)

    def test_no_body_limit_is_set(self) -> None:
        caddyfile = (ROOT / 'Caddyfile').read_text()
        for word in BODY_LIMIT_WORDS:
            self.assertNotIn(word, caddyfile)
        timeout = re.search(r'(?m)^vhostHTTPTimeout\s*=\s*(\d+)', (ROOT / 'relay/frps.toml').read_text())
        self.assertIsNotNone(timeout)
        self.assertGreaterEqual(int(timeout.group(1)), 60)


if __name__ == '__main__':
    unittest.main()
