"""Apply the SQL files to a new database."""

import os
from pathlib import Path

import psycopg


def migrate() -> None:
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        for path in sorted(migrations.glob("*.sql")):
            connection.execute(path.read_text())


if __name__ == "__main__":
    migrate()
