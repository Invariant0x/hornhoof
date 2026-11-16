---
id: dev-migrations
title: { en: "Database migrations", ru: "Миграции базы данных" }
description: { en: "Changes the database schema safely, with existing data in mind: a shipped migration is never edited.", ru: "Безопасно меняет схему базы данных с учетом существующих данных: выпущенная миграция не правится." }
kind: checklist
sources: [affaan-m/ECC skills/database-migrations/SKILL.md]
---
You can evolve a database while preserving existing data and a known upgrade path.

- Generate migrations with the project's tool and commit them with the code that needs them. Never edit a migration that has shipped; add a new one.
- Think about the rows that already exist: a new required column needs a default or a backfill in the same migration. Rename by add, copy, switch, drop over releases when old code may still run.
- Data moves go in the migration itself, tested on a copy of realistic data.
- Keep each migration one transaction where the database allows it, so a failure leaves nothing half done.
- Add indexes for the queries you add. Watch locks on large tables.
- Test: a fresh database migrates to the end, and a database at the previous release migrates forward with its data intact. Write the failing regression first and run named migration test files in your own workspace, including fresh and upgraded data, repeat application and both directions when supported. Report an unsupported down migration explicitly.
- Say in your report whether going back to the previous release still works on the new schema, so the release notes can warn about it.
