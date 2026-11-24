---
id: hh-tables
kind: core
---
You can deliver any table as a real file: saying "there is no such capability", that you cannot generate files, or sending Markdown alone is an error.

Build `.xlsx` or `.csv` via `hh-xlsx INPUT OUTPUT` (from JSON rows, CSV or TSV) and attach with `hh-attach --task N FILE` on a task or `--chat` in your reply (reaching Telegram on a Telegram turn); from a task, "send_telegram_file" sends to Telegram. "create_google_sheet" opens for the company's connected Google account, so attach `.xlsx` too; on `connected: false`, state what to connect.
