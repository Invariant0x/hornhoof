"""The relay counts the bytes its public interface sent each month: plan 9c Task 12, addendum A2 to plan 1."""

import calendar
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

if __package__:
    from .harness import ROOT
else:
    from harness import ROOT

ROUTE_HEAD = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n'
GB = 10**9


def utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> int:
    return calendar.timegm((year, month, day, hour, minute, second))


def route_line(iface: str, destination: str) -> str:
    return f'{iface}\t{destination}\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'


class TrafficCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-traffic-')))
        spec = importlib.util.spec_from_file_location('relay_traffic_under_test', ROOT / 'relay/relay.py')
        self.relay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.relay)
        self.relay.DB_PATH = str(self.tmp / 'relay.db')
        self.relay.init_db()
        self.addCleanup(self.relay.db().close)
        self.proc = self.tmp / 'proc'
        self.sys = self.tmp / 'sys'
        self.set_route('eth0')
        self.set_boot('boot-a')

    def set_route(self, iface: str) -> None:
        (self.proc / 'net').mkdir(parents=True, exist_ok=True)
        (self.proc / 'net' / 'route').write_text(ROUTE_HEAD + route_line(iface, '00000000'))

    def set_boot(self, boot: str) -> None:
        folder = self.proc / 'sys' / 'kernel' / 'random'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'boot_id').write_text(boot + '\n')

    def set_sent(self, iface: str, sent: int) -> None:
        folder = self.sys / 'class' / 'net' / iface / 'statistics'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'tx_bytes').write_text(f'{sent}\n')

    def count(self, at: int) -> int | None:
        return self.relay.count_traffic(at, str(self.proc), str(self.sys))

    def months(self) -> dict[str, int]:
        return dict(self.relay.db().execute('SELECT month, bytes FROM traffic'))


class ReadingTests(TrafficCase):
    def test_default_iface(self) -> None:
        (self.proc / 'net' / 'route').write_text(
            ROUTE_HEAD + route_line('eth0', '0000A8C0') + route_line('eth1', '00000000'))
        self.assertEqual(self.relay.default_iface(str(self.proc)), 'eth1')

    def test_no_default_route(self) -> None:
        (self.proc / 'net' / 'route').write_text(ROUTE_HEAD + route_line('eth0', '0000A8C0'))
        self.assertIsNone(self.relay.default_iface(str(self.proc)))

    def test_unreadable_files_answer_none(self) -> None:
        nothing = str(self.tmp / 'nothing')
        self.assertIsNone(self.relay.default_iface(nothing))
        self.assertIsNone(self.relay.sent_bytes('eth0', nothing))
        self.assertIsNone(self.relay.boot_id(nothing))

    def test_sent_bytes_and_boot_id(self) -> None:
        self.set_sent('eth0', 1234)
        self.assertEqual(self.relay.sent_bytes('eth0', str(self.sys)), 1234)
        self.assertEqual(self.relay.boot_id(str(self.proc)), 'boot-a')


class CountingTests(TrafficCase):
    def test_counts_since_last_read(self) -> None:
        at = utc(2026, 11, 5, 12)
        self.set_sent('eth0', 1000)
        self.assertEqual(self.count(at), 0)
        self.set_sent('eth0', 1500)
        self.assertEqual(self.count(at + 60), 500)
        self.set_sent('eth0', 1400)
        self.assertEqual(self.count(at + 120), 1900)
        self.set_boot('boot-b')
        self.set_sent('eth0', 300)
        self.assertEqual(self.count(at + 180), 2200)
        self.set_route('eth1')
        self.set_sent('eth1', 50)
        self.assertEqual(self.count(at + 240), 2250)

    def test_months_apart(self) -> None:
        self.set_sent('eth0', 1000)
        self.count(utc(2026, 10, 31, 23, 59, 30))
        self.set_sent('eth0', 1700)
        self.count(utc(2026, 11, 1, 0, 0, 30))
        self.assertEqual(self.months(), {'2026-11': 700})

    def test_unreadable_counts_nothing(self) -> None:
        (self.proc / 'net' / 'route').unlink()
        self.assertIsNone(self.count(utc(2026, 11, 5)))
        self.assertEqual(self.months(), {})
        self.assertIsNone(self.relay.db().execute('SELECT 1 FROM traffic_seen').fetchone())

    def test_unreadable_counter_changes_nothing(self) -> None:
        self.set_sent('eth0', 1000)
        self.count(utc(2026, 11, 5))
        (self.sys / 'class' / 'net' / 'eth0' / 'statistics' / 'tx_bytes').unlink()
        self.assertIsNone(self.count(utc(2026, 11, 5, 0, 1)))
        self.assertEqual(self.relay.db().execute('SELECT sent FROM traffic_seen').fetchone(), (1000,))


class AdminTrafficTests(TrafficCase):
    def admin_traffic(self) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(ROOT / 'relay/relay.py'), 'admin', 'traffic'],
                              env=os.environ | {'RELAY_DB': self.relay.DB_PATH}, capture_output=True, text=True,
                              timeout=30)

    def test_lists_months_oldest_first(self) -> None:
        for month, sent in (('2026-10', 2 * GB + 340_000_000), ('2026-08', 5 * GB), ('2026-09', 1_250_000_000)):
            self.relay.write('INSERT INTO traffic (month, bytes) VALUES (?, ?)', (month, sent))
        said = self.admin_traffic()
        self.assertEqual(said.returncode, 0, said.stderr)
        self.assertEqual(said.stdout.splitlines(), ['2026-08  5.0 GB', '2026-09  1.2 GB', '2026-10  2.3 GB'])

    def test_keeps_the_last_twelve(self) -> None:
        for number in range(1, 15):
            month = f'2025-{number:02d}' if number <= 12 else f'2026-{number - 12:02d}'
            self.relay.write('INSERT INTO traffic (month, bytes) VALUES (?, ?)', (month, number * GB))
        lines = self.admin_traffic().stdout.splitlines()
        self.assertEqual((len(lines), lines[0], lines[-1]), (12, '2025-03  3.0 GB', '2026-02  14.0 GB'))

    def test_no_rows(self) -> None:
        self.assertEqual(self.admin_traffic().stdout, 'No traffic counted yet.\n')


class WarningTests(TrafficCase):
    def round_at(self, at: int, warned: str | None) -> tuple[str | None, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            warned = self.relay.traffic_round(at, warned, str(self.proc), str(self.sys))
        return warned, out.getvalue()

    def test_warns_once_a_day(self) -> None:
        self.relay.write('INSERT INTO traffic (month, bytes) VALUES (?, ?)', ('2026-11', 300 * GB + 60_000_000))
        self.set_sent('eth0', 10)
        day = utc(2026, 11, 5, 8)
        warned, first = self.round_at(day, None)
        warned, second = self.round_at(day + 3600, warned)
        warned, third = self.round_at(utc(2026, 11, 6, 8), warned)
        said = 'Sent 300.1 GB this month, past 300 GB: time to resize the server.'
        self.assertEqual((first.strip(), second, third.strip()), (said, '', said))

    def test_a_month_below_the_limit_is_quiet(self) -> None:
        self.relay.write('INSERT INTO traffic (month, bytes) VALUES (?, ?)', ('2026-11', 299 * GB))
        self.set_sent('eth0', 10)
        self.assertEqual(self.round_at(utc(2026, 11, 5), None), (None, ''))

    def test_an_unreadable_round_goes_on(self) -> None:
        (self.proc / 'net' / 'route').unlink()
        self.assertEqual(self.round_at(utc(2026, 11, 5), '2026-11-04'), ('2026-11-04', ''))

    def test_a_failing_round_is_one_log_line(self) -> None:
        def broken(*_args: object) -> None:
            raise OSError('disk gone')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.relay.safe_traffic_round(broken, 1, '2026-11-04'), '2026-11-04')
        self.assertEqual(out.getvalue().strip(), 'Traffic count failed: OSError: disk gone')


if __name__ == '__main__':
    unittest.main()
