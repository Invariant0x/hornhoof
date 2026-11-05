import os
from collections.abc import Iterator

import psycopg
import pytest


@pytest.fixture
def database() -> Iterator[psycopg.Connection]:
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        connection.execute("TRUNCATE baskets RESTART IDENTITY")
        yield connection
