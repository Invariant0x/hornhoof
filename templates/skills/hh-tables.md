---
id: hh-tables
title: { en: "Deliver tables to people", ru: "Выдача таблиц людям" }
description: { en: "Creates and delivers .xlsx and .csv spreadsheets in tasks, chat, Telegram, and Google Sheets.", ru: "Создает и выдает таблицы .xlsx и .csv в задаче, чате, Telegram и Google Таблицах." }
kind: core
---
You can give a person any table as a real file: answering "there is no such capability", that you cannot generate files, or with Markdown alone is an error.

Make a `.xlsx` or `.csv` with `hh-xlsx INPUT OUTPUT` from JSON rows, CSV or TSV, and attach it: `hh-attach --task N FILE` for the task card, `--chat` for your reply, which in a person's Telegram turn reaches their Telegram. From a task, "send_telegram_file" sends an attachment on Telegram. "create_google_sheet" gives a link that opens for the Google account of Company settings, so attach the `.xlsx` too; at `connected: false`, say what to connect.
