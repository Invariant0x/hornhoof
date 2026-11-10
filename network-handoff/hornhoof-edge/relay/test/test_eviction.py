"""A silent client goes and an idle client stays: R3.1 and R3.2 with real frp."""

import tempfile
import time
import unittest

from relay.relay import EVICTION_BOUND_S

if __package__:
    from .harness import Client, Stack
else:
    from harness import Client, Stack


class EvictionTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-eviction-'))
        self.stack = self.enterContext(Stack(tmp))

    def route(self, binding: dict) -> dict:
        status, body = self.stack.api(
            'GET', f'/api/v1/links/{binding["name"]}/route', key=binding['key'])
        self.assertEqual(status, 200)
        return body

    def start_client(self, settings: str, name: str = 'acme') -> tuple[dict, Client, dict]:
        binding = self.stack.bind(name)
        client_id = f'{name}-aaaaaaaa-link' if settings == 'network' else None
        client = self.stack.client(name, binding['key'], settings=settings, client=client_id)
        self.assertTrue(client.started(name), client.log())
        held = self.route(binding)
        self.assertEqual(held['state'], 'held')
        self.assertEqual(held['generation'], 1)
        self.assertEqual(held['evictionBound'], EVICTION_BOUND_S)
        return binding, client, held

    def wait_route(self, binding: dict, state: str, within: float) -> dict:
        deadline = time.monotonic() + within
        while True:
            body = self.route(binding)
            if body['state'] == state:
                return body
            remaining = deadline - time.monotonic()
            self.assertGreater(
                remaining, 0, f'route stayed {body["state"]}, wanted {state} within {within} s')
            time.sleep(min(0.5, remaining))

    def evict(self, settings: str) -> tuple[dict, Client, dict]:
        binding, client, held = self.start_client(settings)
        started = time.monotonic()
        client.pause()
        empty = self.wait_route(binding, 'empty', EVICTION_BOUND_S)
        elapsed = time.monotonic() - started
        print(f'eviction took {elapsed:.2f} s ({settings})', flush=True)
        self.assertLessEqual(elapsed, EVICTION_BOUND_S)
        self.assertEqual(empty['generation'], held['generation'])
        self.assertIsNone(empty['client'])
        return binding, client, held

    def test_r3_1_silent_network_client_goes(self) -> None:
        self.evict('network')

    def test_r3_1_silent_today_client_goes(self) -> None:
        self.evict('today')

    def test_r3_2_idle_clients_stay(self) -> None:
        today = self.start_client('today', 'acme-today')
        network = self.start_client('network', 'acme-network')
        time.sleep(150)
        for binding, client, before in (today, network):
            with self.subTest(settings=binding['name']):
                after = self.route(binding)
                self.assertEqual(after['state'], 'held', client.log())
                self.assertEqual(after['generation'], before['generation'])
                self.assertEqual(after['client'], before['client'])
                self.assertEqual(self.stack.get(f'{binding["name"]}.hornhoof.org'), 200)

    def test_r3_1_back_after_eviction(self) -> None:
        binding, client, before = self.evict('network')
        client.resume()
        after = self.wait_route(binding, 'held', 60)
        self.assertEqual(after['generation'], before['generation'] + 1)
        self.assertEqual(after['client'], before['client'])
        self.assertEqual(self.stack.get('acme.hornhoof.org'), 200)


if __name__ == '__main__':
    unittest.main()
