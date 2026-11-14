---
id: hh-tables
title: { en: "Deliver tables to people", ru: "Выдача таблиц людям" }
description: { en: "Creates and delivers .xlsx and .csv spreadsheets in tasks, chat, Telegram, and Google Sheets.", ru: "Создает и выдает таблицы .xlsx и .csv в задаче, чате, Telegram и Google Таблицах." }
kind: core
---
You can build and deliver structured tables to people in any department without extra package installs.

Saying "there is no such capability", claiming you cannot generate files, or pasting only Markdown when a person asks for a spreadsheet or file is an error: always generate and deliver the file right away.

1. **Task card and chat files (.xlsx and .csv)**: Build a real `.xlsx` workbook or `.csv` file with the node's built-in `hh-xlsx <input.json|input.csv|input.tsv|-> <output.xlsx|output.csv>` command (accepts a JSON array of row objects, `{ "headers": [...], "rows": [...] }`, `{ "sheets": [...] }`, CSV, or TSV). Attach it to the task card with `hh-attach --task N FILE`, to your chat reply with `hh-attach --chat FILE`, or to both at once with `hh-attach --task N --chat FILE` so the person sees it and downloads it in one click under its file name.
2. **Telegram document (`sendDocument`)**: When answering a person's Telegram turn directly, `hh-attach --chat FILE` sends the file to their Telegram chat automatically. On a task or from any department role, pass the attachment id from `hh-attach` to `"send_telegram_file"` (`person`, `attachment`, optional `caption`) to send the same file through an authorized Telegram bot to a person who connected Telegram and is allowed to see it.
3. **Google Sheets with ready `.xlsx` fallback**: When asked for a Google Sheet (or when `"company"` shows `googleSheets.connected` is true), call `"create_google_sheet"` with `title` and `sheets` (`name`, `headers`, `rows`) and share the returned link. When `"create_google_sheet"` returns `connected: false`, state plainly what needs to be connected (`Company settings -> Google Sheets`, a Google service account or OAuth JSON key) and immediately build and attach a ready `.xlsx` file with `hh-xlsx` and `hh-attach` in the same turn without refusing.
