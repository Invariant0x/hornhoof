"""Today's edge pinned: the repo's own Caddyfile on a real Caddy, in front of a real frps and relay."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

if __package__:
    from .harness import BIN, Client, ROOT, Stack, _Process, _dns_names, _ensure_binaries, render_caddyfile
else:
    from harness import BIN, Client, ROOT, Stack, _Process, _dns_names, _ensure_binaries, render_caddyfile


SCRIPT = BIN.parent / 'caddy.sh'
FAKE_CURL = '''#!/bin/sh
# Stands in for the download: it records the address asked for and hands back $RELEASE, a real archive that is not
# the release, so that only the checksum can stop the script.
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    https://*) printf '%s\\n' "$1" >> "$ADDRESSES" ;;
  esac
  shift
done
cp "$RELEASE" "$output"
'''
FAKE_UNAME = '''#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$FAKE_OS" ;;
  -m) printf '%s\\n' "$FAKE_ARCH" ;;
esac
'''


class _Recorder(BaseHTTPRequestHandler):
    """Answers with the method and body it got, which the harness's echo server does not read."""

    def do_PUT(self) -> None:
        received = self.rfile.read(int(self.headers['Content-Length']))
        data = json.dumps({'method': self.command, 'body': received.decode()}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:
        pass


class CaddyDownloadTests(unittest.TestCase):
    """caddy.sh in a folder of its own, with the network replaced, so that no test here reaches the release."""

    def setUp(self) -> None:
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-caddy-sh-')))
        shutil.copy(SCRIPT, self.folder / 'caddy.sh')
        self.addresses = self.folder / 'addresses'
        fakes = self.folder / 'fakes'
        fakes.mkdir()
        self.write_executable(fakes / 'curl', FAKE_CURL)
        self.write_executable(fakes / 'uname', FAKE_UNAME)
        self.path = f'{fakes}{os.pathsep}{os.environ["PATH"]}'
        self.release = self.make_fake_release()

    def make_fake_release(self) -> Path:
        contents = self.folder / 'release'
        contents.mkdir()
        self.write_executable(contents / 'caddy', '#!/bin/sh\necho not the release\n')
        archive = self.folder / 'release.tar.gz'
        subprocess.run(['tar', '-czf', str(archive), '-C', str(contents), 'caddy'], check=True)
        return archive

    @staticmethod
    def write_executable(path: Path, text: str) -> None:
        path.write_text(text)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def run_script(self, os_name: str, arch: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ['sh', str(self.folder / 'caddy.sh')], capture_output=True, text=True, timeout=30,
            env=dict(os.environ, PATH=self.path, ADDRESSES=str(self.addresses),
                     RELEASE=str(self.release),
                     FAKE_OS=os_name, FAKE_ARCH=arch),
        )

    def asked_for(self) -> list[str]:
        return self.addresses.read_text().splitlines() if self.addresses.exists() else []

    def test_wrong_checksum_fails_and_installs_nothing(self) -> None:
        for os_name, arch, platform in (
            ('Linux', 'x86_64', 'linux_amd64'), ('Linux', 'amd64', 'linux_amd64'),
            ('Linux', 'aarch64', 'linux_arm64'), ('Linux', 'arm64', 'linux_arm64'),
            ('Darwin', 'x86_64', 'mac_amd64'), ('Darwin', 'arm64', 'mac_arm64'),
        ):
            with self.subTest(os=os_name, arch=arch):
                self.addresses.unlink(missing_ok=True)
                result = self.run_script(os_name, arch)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn('FAILED', result.stdout + result.stderr)
                self.assertEqual(len(self.asked_for()), 1)
                self.assertRegex(
                    self.asked_for()[0],
                    r'^https://github\.com/caddyserver/caddy/releases/download/'
                    rf'v(2\.11\.\d+)/caddy_\1_{platform}\.tar\.gz$',
                )
                self.assertEqual(os.listdir(self.folder / '.bin'), [])

    def test_unknown_platform_fails_before_any_download(self) -> None:
        for os_name, arch in (('Plan9', 'x86_64'), ('Linux', 'mips')):
            with self.subTest(os=os_name, arch=arch):
                result = self.run_script(os_name, arch)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.asked_for(), [])

    def test_installed_caddy_is_kept_without_a_download(self) -> None:
        (self.folder / '.bin').mkdir()
        installed = self.folder / '.bin/caddy'
        self.write_executable(installed, 'already here')
        result = self.run_script('Linux', 'x86_64')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.asked_for(), [])
        self.assertEqual(installed.read_text(), 'already here')


class RenderTests(unittest.TestCase):
    def test_every_replacement_is_applied_in_order(self) -> None:
        rendered = render_caddyfile('one\ntwo\n', [('one', 'uno'), ('two\n', 'dos\n'), ('uno', 'eins')])
        self.assertEqual(rendered, 'eins\ndos\n')

    def test_a_replacement_that_finds_nothing_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, 'gone from the file'):
            render_caddyfile('one\n', [('one', 'uno'), ('gone from the file', 'x')])


    def test_the_error_names_the_file_that_lost_its_line(self) -> None:
        with self.assertRaisesRegex(ValueError, r'relay/edge-frpc\.toml no longer holds'):
            render_caddyfile('one\n', [('gone from the file', 'x')], file='relay/edge-frpc.toml')


class EdgeCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-edge-'))
        self.stack = self.enterContext(Stack(self.tmp, caddy=True))

    def company_online(self, name: str) -> Client:
        binding = self.stack.bind(name)
        client = self.stack.client(name, binding['key'], via='caddy')
        self.assertTrue(client.started(name), client.log())
        return client


class EdgeTodayTests(EdgeCase):
    def test_stub(self) -> None:
        stub = self.stack.https('hornhoof.org')
        self.assertEqual(stub.status, 200)
        self.assertIn(b'<title>Hornhoof</title>', stub.body)
        www = self.stack.https('www.hornhoof.org')
        # The Caddyfile's redir says permanent, which Caddy answers with 301. Its own http redirect below is 308.
        self.assertEqual(www.status, 301)
        self.assertEqual(www.headers['Location'], 'https://hornhoof.org/')
        plain = self.stack.http('hornhoof.org', '/x')
        self.assertEqual(plain.status, 308)
        self.assertEqual(plain.headers['Location'], 'https://hornhoof.org/x')
        challenge = self.stack.http('acme.hornhoof.org', '/.well-known/acme-challenge/t')
        self.assertEqual(challenge.status, 308)
        self.assertEqual(challenge.headers['Location'],
                         'https://acme.hornhoof.org/.well-known/acme-challenge/t')

    def test_api_through_caddy(self) -> None:
        # The relay's watcher probes frps every 0.5 s and health honestly says 503 until its first good probe,
        # which can come after Caddy is up, so this waits on the answer.
        deadline = time.monotonic() + 10
        health = self.stack.https('hornhoof.org', '/api/v1/health')
        while health.status != 200 and time.monotonic() < deadline:
            time.sleep(0.05)
            health = self.stack.https('hornhoof.org', '/api/v1/health')
        self.assertEqual(health.status, 200)
        self.assertIs(json.loads(health.body)['ok'], True)

    def test_reserved_and_unknown(self) -> None:
        reserved = self.stack.https('admin.hornhoof.org')
        self.assertEqual(reserved.status, 404)
        self.assertTrue(reserved.body == (ROOT / 'relay/404.html').read_bytes(),
                        'a reserved name must get the body of relay/404.html')
        self.assertEqual(self.stack.https('nobody.hornhoof.org').status, 404)

    def test_http_mode_company(self) -> None:
        self.company_online('acme')
        answer = self.stack.https('acme.hornhoof.org')
        self.assertEqual(answer.status, 200, answer.error)
        self.assertIn('*.hornhoof.org', answer.cert_names)
        # Caddy names the visitor, and frps adds the address it got the request from, so the visitor stands
        # first, where Hornhoof reads it (apps/server/src/auth/tunnel.ts).
        self.assertEqual(json.loads(answer.body)['xff'], '127.0.0.1, 127.0.0.1')
        self.assertTrue(answer.headers['X-Test-Peer'].endswith(f':{answer.local_port}'),
                        answer.headers['X-Test-Peer'])

    def test_blocked_410(self) -> None:
        self.company_online('acme')
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        self.stack.admin('ban', 'acme')
        self.stack.reload_caddy()
        blocked = self.stack.https('acme.hornhoof.org')
        self.assertEqual(blocked.status, 410)
        self.assertTrue(blocked.body == (ROOT / 'relay/410.html').read_bytes(),
                        'a blocked name must get the body of relay/410.html')

    def test_reload_leaves_a_tunnel_alone(self) -> None:
        client = self.company_online('acme')
        self.stack.admin('ban', 'someone-else')
        self.stack.reload_caddy()
        self.assertEqual(self.stack.https('someone-else.hornhoof.org').status, 410)
        self.assertEqual(self.stack.https('acme.hornhoof.org').status, 200)
        self.assertEqual(client.log().count('login to server success'), 1, client.log())


class StackRequestTests(EdgeCase):
    """What the later tasks rely on from Stack.https and Stack.http."""

    def test_server_name_is_what_the_handshake_carries(self) -> None:
        for server_name in ('example.com', None):
            with self.subTest(server_name=server_name):
                refused = self.stack.https('hornhoof.org', sni=server_name)
                self.assertIsNone(refused.status)
                self.assertTrue(refused.error, 'a failed handshake must say why')
        # Changed from 404 by batch 5's ruling: a Host that is not the handshake's name is misdirected, not served.
        self.assertEqual(self.stack.https('nobody.hornhoof.org', sni='hornhoof.org').status, 421)

    def test_method_and_body_reach_the_company(self) -> None:
        recorder = ThreadingHTTPServer(('127.0.0.1', 0), _Recorder)
        self.addCleanup(recorder.server_close)
        recorder.daemon_threads = True
        thread = threading.Thread(target=recorder.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(recorder.shutdown)
        binding = self.stack.bind('acme')
        client = self.stack.client('acme', binding['key'], via='caddy', proxies=f'''
[[proxies]]
name = "acme"
type = "http"
subdomain = "acme"
localIP = "127.0.0.1"
localPort = {recorder.server_port}
''')
        self.assertTrue(client.started('acme'), client.log())
        answer = self.stack.https('acme.hornhoof.org', method='PUT', body=b'the body')
        self.assertEqual(answer.status, 200, answer.error)
        self.assertEqual(json.loads(answer.body), {'method': 'PUT', 'body': 'the body'})

    def test_kept_connection_carries_a_second_request_on_the_same_socket(self) -> None:
        self.company_online('acme')
        first, kept = self.stack.https('acme.hornhoof.org', '/one', keep=True)
        second = kept.again('/two')
        self.assertEqual(first.status, 200, first.error)
        self.assertEqual(second.status, 200, second.error)
        self.assertEqual(json.loads(first.body)['path'], '/one')
        self.assertEqual(json.loads(second.body)['path'], '/two')
        self.assertEqual(json.loads(second.body)['host'], 'acme.hornhoof.org')
        self.assertEqual(second.local_port, first.local_port)
        self.assertEqual(second.cert_names, first.cert_names)
        self.assertEqual(second.headers['X-Test-Peer'], first.headers['X-Test-Peer'])

    def test_kept_connection_never_dials_again_once_closed(self) -> None:
        answer, kept = self.stack.https('hornhoof.org', keep=True)
        self.assertEqual(answer.status, 200)
        kept.close()
        failed = kept.again('/')
        self.assertIsNone(failed.status)
        self.assertIn('NotConnected', failed.error)
        self.assertEqual(failed.local_port, answer.local_port)

    def test_close_ends_caddy_and_kept_connections(self) -> None:
        _, kept = self.stack.https('hornhoof.org', keep=True)
        self.stack.close()
        self.assertIsNotNone(self.stack.caddy.process.poll())
        self.assertIn('NotConnected', kept.again('/').error)

    def test_refused_connections_read_as_failures(self) -> None:
        self.stack.caddy.stop()
        # frps holds the public https port since Task 9, so without it the port stays open and only the handshake fails.
        self.stack.stop_frps()
        for name, answer in (('https', self.stack.https('hornhoof.org')), ('http', self.stack.http('hornhoof.org'))):
            with self.subTest(name):
                self.assertIsNone(answer.status)
                self.assertIn('ConnectionRefusedError', answer.error)
                self.assertEqual((answer.headers, answer.body, answer.cert_names, answer.local_port),
                                 ({}, b'', [], 0))

    def test_keep_on_a_refused_connection_gives_no_connection(self) -> None:
        self.stack.caddy.stop()
        answer, kept = self.stack.https('hornhoof.org', keep=True)
        self.assertIsNone(answer.status)
        self.assertIsNone(kept)

    def test_http_answer_names_its_own_port(self) -> None:
        answer = self.stack.http('hornhoof.org')
        self.assertGreater(answer.local_port, 0)
        self.assertNotEqual(answer.local_port, self.stack.http_port)
        self.assertEqual(answer.cert_names, [])


class StackCaddyTests(EdgeCase):
    def test_each_answer_owns_its_certificate_names(self) -> None:
        first = self.stack.https('hornhoof.org')
        first.cert_names.append('changed by one test')
        self.assertNotIn('changed by one test', self.stack.https('hornhoof.org').cert_names)

    def test_caddy_listens_on_loopback_only(self) -> None:
        # Built from bytes because this repo's own test allows no other literal loopback address. Linux answers
        # on the whole 127 range, so a server bound to every interface would accept here.
        other_loopback = socket.inet_ntoa(bytes((127, 0, 0, 2)))
        for port in (self.stack.http_port, self.stack.https_port):
            with self.subTest(port=port), self.assertRaises(OSError):
                socket.create_connection((other_loopback, port), timeout=2).close()

    def test_caddy_state_stays_in_the_test_folder(self) -> None:
        self.assertTrue((self.stack.caddy_folder / 'data/caddy/instance.uuid').exists())

    def test_rendered_file_points_at_nothing_of_the_droplet(self) -> None:
        settings = [line for line in (self.stack.caddy_folder / 'Caddyfile').read_text().splitlines()
                    if not line.lstrip().startswith('#')]
        for droplet_value in ('/etc/caddy', '/var/www', ':7600', ':7000', ':8080'):
            with self.subTest(droplet_value):
                self.assertEqual([line for line in settings if droplet_value in line], [])

    def test_rendered_file_leaves_the_https_binds_to_the_repos_own_lines(self) -> None:
        # A global bind would keep https on loopback here with every bind gone from the file, and no test would see the
        # droplet's Caddy open to the internet. Only the http site's bind is the test's own.
        rendered = (self.stack.caddy_folder / 'Caddyfile').read_text()
        self.assertNotIn('default_bind', rendered)
        self.assertEqual(rendered.count('\tbind 127.0.0.1\n'),
                         (ROOT / 'Caddyfile').read_text().count('\tbind 127.0.0.1\n') + 1)

    def test_every_site_shows_the_test_certificate(self) -> None:
        for host in ('hornhoof.org', 'www.hornhoof.org', 'acme.hornhoof.org'):
            with self.subTest(host):
                self.assertEqual(self.stack.https(host).cert_names,
                                 ['hornhoof.org', 'www.hornhoof.org', '*.hornhoof.org'])

    def test_caddy_asks_for_no_certificate(self) -> None:
        self.stack.https('hornhoof.org')
        self.assertFalse('tls.obtain' in self.stack.caddy.log(), 'Caddy must never ask for a certificate here')

    def test_reload_that_never_finishes_raises(self) -> None:
        (self.stack.caddy_folder / 'companies/none.caddy').write_text('this is not { a Caddyfile\n')
        with self.assertRaisesRegex(RuntimeError, 'Caddy did not reload'):
            self.stack.reload_caddy(within=1)

    def test_admin_command_that_fails_raises(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            self.stack.admin('no-such-command')

    def test_unknown_way_in_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, 'Unknown way in'):
            self.stack.client('acme', 'key', via='elsewhere')


class StackFailureTests(unittest.TestCase):
    """A broken step stops the run, loudly, instead of reading as a quiet success further on."""

    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-edge-'))

    def test_no_caddy_unless_asked(self) -> None:
        with Stack(self.tmp) as stack:
            self.assertIsNone(stack.caddy)
            self.assertIsNone(stack.https('hornhoof.org').status)

    def test_failed_download_script_stops_the_run(self) -> None:
        script = Path(self.tmp) / 'fails.sh'
        script.write_text('exit 3\n')
        with self.assertRaises(subprocess.CalledProcessError):
            _ensure_binaries(str(script))

    def test_unreadable_certificate_raises_instead_of_naming_nothing(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            _dns_names(b'not a certificate')

    def test_process_that_exits_during_startup_raises_with_its_log(self) -> None:
        process = _Process([sys.executable, '-c', 'print("why it stopped")'], Path(self.tmp) / 'process.log')
        self.addCleanup(process.stop)
        process.process.wait()
        with self.assertRaisesRegex(RuntimeError, 'why it stopped'):
            Stack._wait_ready(process, lambda: False)


if __name__ == '__main__':
    unittest.main()
