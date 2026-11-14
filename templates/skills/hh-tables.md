---
id: hh-tables
title: { en: "Deliver tables to people", ru: "Выдача таблиц людям" }
description: { en: "Creates and delivers .xlsx and .csv spreadsheets in tasks, chat, Telegram, and Google Sheets.", ru: "Создает и выдает таблицы .xlsx и .csv в задаче, чате, Telegram и Google Таблицах." }
kind: core
---
You can give a person any table as a real file.

Answering "there is no such capability", that you cannot generate files, or with Markdown alone when a person asks for a table or file is an error.

1. Build a real `.xlsx` or `.csv` with `hh-xlsx INPUT OUTPUT` (JSON rows, CSV or TSV in) and attach it: `hh-attach --task N FILE` to the task card, `--chat` to your reply, or both. In a person's Telegram turn `--chat` reaches their Telegram too.
2. To send it on Telegram from a task, pass its attachment id to "send_telegram_file".
3. For a Google Sheet call "create_google_sheet" and give the link. It opens for the Google account in Company settings, so attach the `.xlsx` too for anyone else. When it answers `connected: false`, say what to connect and attach the `.xlsx` in the same turn.
