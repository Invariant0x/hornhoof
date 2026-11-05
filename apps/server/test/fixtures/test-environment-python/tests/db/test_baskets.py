import psycopg
import pytest

pytestmark = pytest.mark.database


def test_first_insert(database: psycopg.Connection) -> None:
    row = database.execute(
        "INSERT INTO baskets (total_cents) VALUES (375) RETURNING id"
    ).fetchone()
    assert row == (1,)


def test_next_test_starts_empty(database: psycopg.Connection) -> None:
    assert database.execute("SELECT count(*) FROM baskets").fetchone() == (0,)
    row = database.execute(
        "INSERT INTO baskets (total_cents) VALUES (100) RETURNING id"
    ).fetchone()
    assert row == (1,)
