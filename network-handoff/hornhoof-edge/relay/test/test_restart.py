"""Health follows frps, and generations survive relay and frps restarts: R2.2, R2.3 and R4.1."""

import hashlib
import secrets
import sqlite3
import tempfile
import threading
import time
import unittest

if __package__:
    from .harness import Stack, _wait
else:
    from harness import Stack, _wait


class RestartTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-restart-'))
        self.stack = self.enterContext(Stack(self.tmp))

    def route(self, binding: dict) -> tuple[int, dict | None]:
        return self.stack.api('GET', f'/api/v1/links/{binding["name"]}/route', key=binding['key'])

    def wait_route(self, binding: dict, state: str, generation: int, within: float) -> dict:
        # The bound is `within` plus one poll quantum: an answer can only be observed at
        # poll times; an answer arriving past that is late and must not be accepted.
        interval = 0.2
        start = time.monotonic()
        while True:
            status, body = self.route(binding)
            if status == 200 and body['state'] == state and body['generation'] == generation:
                self.assertLess(time.monotonic() - start, within + interval,
                                f'{state} at generation {generation} arrived only after '
                                f'the {within} s deadline')
                return body
            self.assertGreater(within + interval - (time.monotonic() - start), 0,
                               f'no {state} at generation {generation} within {within} s: '
                               f'{status} {body}')
            time.sleep(interval)

    def wait_health(self, status: int, within: float) -> dict:
        # The bound is `within` plus one poll quantum: a threshold answer that crosses
        # exactly at the deadline is first seen one quantum later; anything later than
        # that is late and must not be accepted.
        interval = 0.05
        start = time.monotonic()
        while True:
            current, body = self.stack.api('GET', '/api/v1/health')
            if current == status:
                self.assertLess(time.monotonic() - start, within + interval,
                                f'health answered {status} only after the {within} s deadline')
                return body
            self.assertGreater(within + interval - (time.monotonic() - start), 0,
                               f'health did not answer {status} within {within} s: {current} {body}')
            time.sleep(interval)

    def test_wait_health_rejects_an_answer_after_the_deadline(self) -> None:
        # A probe that takes the wanted status past the deadline must not be accepted: the
        # helper checks the clock before accepting, or a slow answer would read as in time.
        def slow_answer(method: str, path: str, body: dict | None = None, key: str | None = None):
            time.sleep(0.5)
            return 503, {'ok': False, 'frps': False}

        original = self.stack.api
        self.stack.api = slow_answer
        try:
            with self.assertRaises(AssertionError):
                self.wait_health(503, 0.2)
        finally:
            self.stack.api = original

    def make_binding(self, name: str) -> dict:
        """A binding written straight into the relay's database: the API's per-address limit
        would stop 40 creations from one address."""
        key = secrets.token_urlsafe(32)
        digest = hashlib.sha256(key.encode()).hexdigest()
        with sqlite3.connect(self.stack.env['RELAY_DB'], timeout=10) as conn:
            conn.execute('INSERT INTO bindings (name, key_hash, created_at, created_ip) VALUES (?, ?, ?, ?)',
                         (name, digest, int(time.time()), 'test'))
        self.stack.private.append(key)
        return {'name': name, 'key': key}

    def start_network_client(self, binding: dict) -> None:
        client = self.stack.client(binding['name'], binding['key'], settings='network',
                                   client=f"{binding['name']}-aaaaaaaa-link")
        self.assertTrue(client.started(binding['name']), client.log())

    def sample_route(self, binding: dict, stop: threading.Event, samples: list,
                     started: threading.Event) -> None:
        while True:
            try:
                samples.append((time.monotonic(), *self.route(binding)))
            except OSError:
                samples.append((time.monotonic(), None, None))
            started.set()
            if stop.wait(0.2):
                return

    def sample_traffic(self, binding: dict, stop: threading.Event, answers: list,
                       started: threading.Event, interval: float = 0.1) -> None:
        host = f'{binding["name"]}.hornhoof.org'
        while True:
            try:
                answers.append((time.monotonic(), self.stack.get(host)))
            except OSError:
                answers.append((time.monotonic(), None))
            started.set()
            if stop.wait(interval):
                return

    def test_r4_1_health_follows_frps(self) -> None:
        body = self.wait_health(200, 10)
        self.assertEqual(body['frps'], True)
        self.assertIsInstance(body['relayStarted'], int)
        self.stack.stop_frps()
        body = self.wait_health(503, 2)
        self.assertEqual(body, {'ok': False, 'frps': False})
        started = int(time.time())
        self.stack.start_frps()
        body = self.wait_health(200, 3)
        self.assertEqual(body['frps'], True)
        self.assertGreaterEqual(body['relayStarted'], started)

    def refuse_route_calls(self, binding: dict, within: float = 5) -> None:
        """The route call must fail to connect while the relay is down; poll until it does."""
        deadline = time.monotonic() + within
        while True:
            try:
                self.route(binding)
            except OSError:
                return
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, 'the route call still connects after the relay stopped')
            time.sleep(0.02)

    def test_r2_2_generation_survives_relay_restart(self) -> None:
        binding = self.stack.bind('acme')
        self.start_network_client(binding)
        held = self.wait_route(binding, 'held', 1, 10)
        samples: list = []
        traffic: list = []
        stop = threading.Event()
        route_started = threading.Event()
        traffic_started = threading.Event()
        sampler = threading.Thread(target=self.sample_route,
                                   args=(binding, stop, samples, route_started), daemon=True)
        traffic_sampler = threading.Thread(target=self.sample_traffic,
                                           args=(binding, stop, traffic, traffic_started), daemon=True)
        sampler.start()
        traffic_sampler.start()
        self.assertTrue(route_started.wait(timeout=5), 'the route sampler never sampled')
        self.assertTrue(traffic_started.wait(timeout=5), 'the traffic sampler never sampled')
        try:
            # Split the restart: between stop and start the relay must refuse connections,
            # and that window is measured from the main thread, not left to sampling luck.
            down_from = time.monotonic()
            self.stack.relay.stop()
            self.refuse_route_calls(binding)
            # Keep the relay down long enough for the samplers to see the down phase.
            time.sleep(0.3)
            self.stack._start_relay()
            back_at = time.monotonic()
            # Let the samplers take a sample of the relay being back before stopping them.
            deadline = time.monotonic() + 5
            while not any(at > back_at for at, _ in traffic) and time.monotonic() < deadline:
                time.sleep(0.02)
        finally:
            stop.set()
            sampler.join(timeout=10)
            traffic_sampler.join(timeout=10)
        self.assertFalse(sampler.is_alive(), 'the route sampler outlived the test')
        self.assertFalse(traffic_sampler.is_alive(), 'the traffic sampler outlived the test')
        answered = [sample for sample in samples if sample[1] is not None]
        self.assertTrue(answered, 'the route call was never sampled while the relay was up')
        self.assertTrue(all(sample[1] == 200 for sample in answered), answered)
        self.assertTrue(traffic, 'company traffic was never sampled')
        during_down = [answer for at, answer in traffic if down_from <= at <= back_at]
        after_back = [answer for at, answer in traffic if at > back_at]
        self.assertTrue(during_down, 'no company traffic sample while the relay was down')
        self.assertTrue(after_back, 'no company traffic sample after the relay came back')
        self.assertTrue(all(answer == 200 for _, answer in traffic),
                        f'company traffic was not served throughout the restart: {traffic}')
        after = self.wait_route(binding, 'held', 1, 15)
        self.assertEqual(after['client'], 'acme-aaaaaaaa-link')
        self.assertEqual(after['generation'], held['generation'])

    def test_r2_2_generation_survives_frps_restart(self) -> None:
        binding = self.stack.bind('acme')
        self.start_network_client(binding)
        before = self.wait_route(binding, 'held', 1, 10)
        # relayStarted has second resolution: let the second roll over before the restart,
        # so "moved to the restart" cannot pass with the pre-restart value.
        marked = int(time.time())
        while int(time.time()) == marked:
            time.sleep(0.05)
        samples: list = []
        stop = threading.Event()
        route_started = threading.Event()
        sampler = threading.Thread(target=self.sample_route,
                                   args=(binding, stop, samples, route_started), daemon=True)
        sampler.start()
        self.assertTrue(route_started.wait(timeout=5), 'the route sampler never sampled')
        self.stack.restart_frps()
        restarted = time.monotonic()
        try:
            held = self.wait_route(binding, 'held', 2, 60)
        finally:
            stop.set()
            sampler.join(timeout=10)
        self.assertFalse(sampler.is_alive(), 'the route sampler outlived the test')
        self.assertEqual(held['client'], 'acme-aaaaaaaa-link')
        self.assertGreater(held['relayStarted'], before['relayStarted'])
        self.assertTrue(samples, 'the route call was never sampled')
        stale = [sample for sample in samples
                 if sample[0] > restarted and sample[1] == 200
                 and sample[2]['state'] == 'held' and sample[2]['generation'] == 1]
        self.assertFalse(stale, stale)

    def test_restart_burst(self) -> None:
        bindings = [self.make_binding(f'burst{i:02d}') for i in range(40)]
        for binding in bindings:
            self.start_network_client(binding)
        for binding in bindings:
            self.wait_route(binding, 'held', 1, 30)
        base = len(self.stack.plugin_calls())
        self.stack.restart_frps()
        deadline = time.monotonic() + 60
        for binding in bindings:
            self.wait_route(binding, 'held', 2, max(deadline - time.monotonic(), 0.5))
        calls = self.stack.plugin_calls()[base:]
        expected = {binding['name'] for binding in bindings}
        registered = {call['proxy_name'] for call in calls if call['op'] == 'NewProxy'}
        self.assertEqual(registered, expected,
                         f'missing registrations after the restart: {expected - registered}')
        rejected = [call for call in calls if call['reject']]
        self.assertFalse(rejected, f'plugin calls were rejected after the restart: {rejected}')
        self.assertNotIn('relay error: busy', self.stack.relay.log())
        for call in calls:
            self.assertLess(call['ms'], 1000, call)


if __name__ == '__main__':
    unittest.main()
