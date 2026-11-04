"""The relay's SQLite writes under a burst: plan 1's Review Focus 3, without a real disk or 40 processes."""

import contextlib
import importlib.util
import sqlite3
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

if __package__:
    from .harness import ROOT
else:
    from harness import ROOT

KEY = 'k'
# 40 commits of 30 ms under one lock are 1.2 s, so at most 26 of them fit in a write's 0.8 s budget, however the
# threads are scheduled. Commits shared by the whole burst need only a few of those 30 ms, which leaves most of it free.
LINKS = 40
COMMIT_S = 0.03


class SlowDisk(sqlite3.Connection):
    """A disk where each commit costs COMMIT_S with SQLite's write lock held, as fsync does under synchronous=FULL.

    A write outside a transaction commits by itself, so it costs the same.
    """

    commit_s = COMMIT_S

    def execute(self, sql: str, *args):
        if sql.startswith(('INSERT', 'UPDATE', 'DELETE')) and not self.in_transaction:
            super().execute('BEGIN IMMEDIATE')
            cursor = super().execute(sql, *args)
            self.execute('COMMIT')
            return cursor
        if sql == 'COMMIT':
            time.sleep(self.commit_s)
        return super().execute(sql, *args)


class StallingDisk(SlowDisk):
    """A disk whose commit outlives the whole budget of any write that waits for it."""

    commit_s = 0.9


class FailingDisk(sqlite3.Connection):
    """A disk that fails the first commit made on it, across all of a test's connections."""

    failures_left = 0

    def execute(self, sql: str, *args):
        if sql == 'COMMIT' and FailingDisk.failures_left > 0:
            FailingDisk.failures_left -= 1
            raise sqlite3.OperationalError('disk I/O error')
        return super().execute(sql, *args)


def until(predicate: Callable[[], bool], within: float) -> None:
    """A moment in the writer's queue can be short, so poll tightly. What relies on the moment checks its own result."""
    deadline = time.monotonic() + within
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.001)


class FullDisk(sqlite3.Connection):
    """A disk that fills up under one statement, where SQLite ends the whole transaction by itself (SQLITE_FULL)."""

    def execute(self, sql: str, *args):
        if args == (('fills the disk',),):
            super().execute('ROLLBACK')
            raise sqlite3.OperationalError('database or disk is full')
        return super().execute(sql, *args)


@contextlib.contextmanager
def relay_connections_are(connection_class: type[sqlite3.Connection]):
    """Connections opened meanwhile are of this class, which is how a test stands for the disk under the relay."""
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        return real_connect(*args, factory=connection_class, **kwargs)

    with patch.object(sqlite3, 'connect', connect):
        yield


class RelayWrites(unittest.TestCase):

    def setUp(self) -> None:
        tmp = self.enterContext(tempfile.TemporaryDirectory(prefix='hornhoof-writes-'))
        spec = importlib.util.spec_from_file_location('relay_writes_under_test', ROOT / 'relay/relay.py')
        self.relay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.relay)
        self.relay.DB_PATH = str(Path(tmp) / 'relay.db')
        self.relay.init_db()
        self.addCleanup(self.relay.db().close)

    def bind(self, name: str) -> None:
        self.relay.write('INSERT INTO bindings (name, key_hash, created_at) VALUES (?, ?, ?)',
                         (name, self.relay.key_hash(KEY), self.relay.now()))

    def on_threads(self, calls: list[Callable]) -> list:
        """Each call on its own thread, all at once, as the relay's server runs them: answers, or what they raised."""
        start = threading.Barrier(len(calls))
        answers = [None] * len(calls)

        def run(index: int, call: Callable) -> None:
            start.wait()
            try:
                answers[index] = call()
            except (self.relay.WriteBusy, sqlite3.Error) as refused:
                answers[index] = refused
            finally:
                self.relay.db().close()

        threads = [threading.Thread(target=run, args=item, daemon=True) for item in enumerate(calls)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertFalse(any(thread.is_alive() for thread in threads), 'a write outlived every budget')
        return answers

    def within(self, seconds: float, call: Callable) -> Callable:
        """The call, run with a plugin call's budget of these seconds."""
        def budgeted():
            self.relay.call_state.end = time.monotonic() + seconds
            try:
                return call()
            finally:
                self.relay.call_state.end = None
        return budgeted

    def queued(self, count: int) -> Callable[[], bool]:
        return lambda: len(self.relay.writer.queue) >= count

    def after_queued(self, count: int, call: Callable, within: float = 5) -> Callable:
        """The call, run once so many writes wait for the writer, which fixes who heads the queue."""
        def in_order():
            until(self.queued(count), within)
            return call()
        return in_order

    def creation(self, ip: str) -> Callable:
        return lambda: self.relay.write('INSERT INTO creations (ip, at) VALUES (?, 0)', (ip,))

    def creations(self) -> set[str]:
        return {row[0] for row in self.relay.db().execute('SELECT ip FROM creations')}

    def hold_writing_until(self, release: Callable[[], bool]) -> None:
        """A thread keeps the relay's write transaction open until told, forming a queue; returns once it is open."""
        opened = threading.Event()

        def hold() -> None:
            try:
                with self.relay.transaction():
                    opened.set()
                    until(release, 5)
            finally:
                self.relay.db().close()

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.addCleanup(holder.join, 5)
        self.assertTrue(opened.wait(5), 'the holder must get its transaction')

    def hold_sqlite_from_another_process(self, seconds: float) -> None:
        """What `relay.py admin` does: SQLite's write lock taken by a connection that knows nothing of the writer."""
        taken = threading.Event()

        def hold() -> None:
            conn = sqlite3.connect(self.relay.DB_PATH, isolation_level=None)
            conn.execute('BEGIN IMMEDIATE')
            taken.set()
            time.sleep(seconds)
            conn.execute('ROLLBACK')
            conn.close()

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.addCleanup(holder.join, 5)
        self.assertTrue(taken.wait(5), 'the holder must get the lock')

    def login(self, name: str) -> tuple:
        """What frps and its client would see of one Login: the answer, whether it is on record, how long it took."""
        started = time.monotonic()
        answer = self.relay.plugin('Login', {'metas': {'name': name, 'key': KEY}})
        elapsed = time.monotonic() - started
        seen = self.relay.db().execute('SELECT last_seen FROM bindings WHERE name = ?', (name,)).fetchone()[0]
        return answer, seen is not None, elapsed < self.relay.PLUGIN_CALL_S

    def test_a_burst_of_logins_on_a_slow_disk_is_refused_nowhere(self) -> None:
        names = [f'burst{i:02d}' for i in range(LINKS)]
        for name in names:
            self.bind(name)
        with relay_connections_are(SlowDisk):
            answers = self.on_threads([lambda name=name: self.login(name) for name in names])
        let_through = ({'reject': False, 'unchange': True}, True, True)
        self.assertEqual([answer for answer in answers if answer != let_through], [])

    def test_writers_get_their_turn_while_another_keeps_taking_the_lock(self) -> None:
        # The lock is free only for an instant between one holder's transactions, so a writer that polls for it misses
        # that instant for its whole budget.
        finished = threading.Event()

        def keep_taking_the_lock() -> None:
            try:
                while not finished.is_set():
                    with self.relay.transaction():
                        time.sleep(0.05)
            finally:
                self.relay.db().close()

        holder = threading.Thread(target=keep_taking_the_lock, daemon=True)
        holder.start()
        self.addCleanup(holder.join, 5)
        wanted = {f'writer{i}' for i in range(12)}
        answers = self.on_threads([self.creation(ip) for ip in sorted(wanted)])
        finished.set()
        self.assertEqual([answer for answer in answers if answer != 1], [])
        self.assertEqual(self.creations(), wanted)

    def test_a_write_out_of_budget_in_the_queue_is_refused_on_time_and_never_lands(self) -> None:
        refused = threading.Event()
        self.hold_writing_until(refused.is_set)
        answers = self.on_threads([self.within(0.05, self.creation('out of budget'))])
        refused.set()
        self.assertIsInstance(answers[0], self.relay.WriteBusy)
        self.relay.write('INSERT INTO creations (ip, at) VALUES (?, 0)', ('later',))
        self.assertEqual(self.creations(), {'later'}, 'a refused write must never land')

    def test_a_write_refused_behind_another_process_leaves_the_others_their_budgets(self) -> None:
        # The head of the queue spends its budget on the other process's lock, with the others queued behind it. The
        # next head does too, and only the last one's budget outlasts the lock. Their order only sharpens the test: in
        # any order the first two budgets end before the lock does.
        self.hold_sqlite_from_another_process(0.5)
        first, second, last = self.on_threads([
            self.within(0.1, self.creation('first')),
            self.after_queued(1, self.within(0.2, self.creation('second')), within=0.05),
            self.after_queued(2, self.within(self.relay.PLUGIN_CALL_S, self.creation('last')), within=0.05)])
        self.assertIsInstance(first, self.relay.WriteBusy)
        self.assertIsInstance(second, self.relay.WriteBusy)
        self.assertEqual(last, 1)
        self.assertEqual(self.creations(), {'last'})

    def test_a_plugin_call_stops_waiting_for_a_commit_that_outlives_its_budget(self) -> None:
        # The first in the queue runs the commit and the API's write behind it wants the truth: both wait for the disk.
        self.hold_writing_until(self.queued(3))
        waited = []

        def plugin_write():
            started = time.monotonic()
            try:
                return self.creation('plugin')()
            finally:
                waited.append(time.monotonic() - started)

        with relay_connections_are(StallingDisk):
            first, api, plugin = self.on_threads([
                self.creation('first'),
                self.after_queued(1, self.creation('api')),
                self.after_queued(2, self.within(0.25, plugin_write))])
        self.assertIsInstance(plugin, self.relay.WriteBusy)
        self.assertLess(waited[0], StallingDisk.commit_s, 'the plugin call must not wait for the stalled commit')
        self.assertEqual((first, api), (1, 1))
        self.assertLessEqual({'first', 'api'}, self.creations())

    def assert_fails_alone(self, bad: Callable, failure: type[sqlite3.Error]) -> None:
        """The bad statement sits between two others in one commit: its owner hears of it, and the others land."""
        self.hold_writing_until(self.queued(3))
        first, answer, second = self.on_threads([self.creation('first'), self.after_queued(1, bad),
                                                 self.after_queued(2, self.creation('second'))])
        self.assertIsInstance(answer, failure)
        self.assertEqual((first, second), (1, 1))
        self.assertEqual(self.creations(), {'first', 'second'})

    def test_a_statement_that_breaks_a_constraint_fails_alone(self) -> None:
        self.bind('taken')
        self.assert_fails_alone(lambda: self.relay.write(
            'INSERT INTO bindings (name, key_hash, created_at) VALUES (?, ?, 0)', ('taken', '-')),
            sqlite3.IntegrityError)

    def test_a_value_sqlite_cannot_store_fails_alone(self) -> None:
        # A plugin call's fields come from a client, so one client's odd value must not undo another's commit.
        self.assert_fails_alone(self.creation({'not': 'storable'}), sqlite3.Error)

    def test_a_failure_that_ends_the_transaction_reaches_every_owner(self) -> None:
        self.hold_writing_until(self.queued(3))
        with relay_connections_are(FullDisk):
            answers = self.on_threads([self.creation('first'), self.after_queued(1, self.creation('fills the disk')),
                                       self.after_queued(2, self.creation('second'))])
        self.assertEqual([answer for answer in answers if not isinstance(answer, sqlite3.OperationalError)], [])
        self.assertEqual(self.creations(), set(), 'nothing of the failed transaction may land')

    def test_a_failed_commit_tells_its_owners_and_frees_the_writer(self) -> None:
        self.hold_writing_until(self.queued(8))
        FailingDisk.failures_left = 1
        with relay_connections_are(FailingDisk):
            answers = self.on_threads([self.creation(f'writer{i}') for i in range(8)])
        self.assertEqual([answer for answer in answers if not isinstance(answer, sqlite3.OperationalError)], [])
        self.assertEqual(self.creations(), set(), 'a write lands exactly when its owner is told so')
        self.relay.write('INSERT INTO creations (ip, at) VALUES (?, 0)', ('after',))
        self.assertIn('after', self.creations())

    def test_a_visitor_key_stored_in_a_shared_commit_answers_for_itself(self) -> None:
        names = ['one', 'two', 'three']
        for name in names:
            self.bind(name)
        self.hold_writing_until(self.queued(4))
        link_hash = self.relay.key_hash(KEY)
        answers = self.on_threads([lambda name=name: self.relay.store_visitor_key(name, 'hash', link_hash)
                                   for name in names]
                                  + [lambda: self.relay.store_visitor_key('one', 'hash', 'not the link key')])
        self.assertEqual(answers, [True, True, True, False])

    def test_a_sync_record_stored_in_a_shared_commit_answers_for_itself(self) -> None:
        names = ['one', 'two', 'three']
        for name in names:
            self.bind(name)
            self.relay.write('INSERT INTO routes (name, generation, client, run_id, type, state, since) '
                             "VALUES (?, 1, 'holder', '', 'http', 'held', 0)", (name,))
        self.hold_writing_until(self.queued(4))
        link_hash = self.relay.key_hash(KEY)
        record = {'client': 'holder', 'generation': 1, 'state': 'on', 'copy': 'copy', 'epoch': 1}
        answers = self.on_threads([lambda name=name: self.relay.store_sync(name, record, link_hash)
                                   for name in names]
                                  + [lambda: self.relay.store_sync('one', record | {'client': 'not the holder'},
                                                                   link_hash)])
        self.assertEqual(answers, [True, True, True, False])

    def test_a_commit_waits_for_the_disk(self) -> None:
        # R2.4 wants a sync record on disk before its answer: under WAL only FULL syncs at every commit.
        full = 2
        self.assertEqual(self.relay.db().execute('PRAGMA synchronous').fetchone()[0], full)


if __name__ == '__main__':
    unittest.main()
