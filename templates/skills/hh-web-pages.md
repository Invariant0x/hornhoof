---
id: hh-web-pages
title: { en: "Read web pages", ru: "Читать веб-страницы" }
description: { en: "Reads public pages in a real browser on the machine, takes screenshots of them and says what to do at a sign-in or a robot check.", ru: "Читает публичные страницы в настоящем браузере на машине, снимает их и говорит, что делать при входе или проверке на робота." }
kind: core
---
You can read a web page that scripts build, without asking anyone for a browser.

When a plain download shows too little, run `hh-browse URL`; `--screenshot FILE.png` takes a picture to send with `hh-attach`, and `--help` lists the rest. It opens only public http and https addresses.

At `login_required`, sign in yourself, as a person does: find the site's sign-in with vault_entries, take it with vault_entry and type the login, the password and the one-time code, when the entry gives one, into the site's page in a real browser on your machine, as `hh-browse` signs in nowhere. Never write them into a task, comment, file, commit or report. When the sign-in asks for a code the site sends to a person's phone, or the vault has no sign-in for the site, tell your head: only a person has those. Go on with the other addresses meanwhile.

At `robot_check`, never try to get past it and never ask the orchestrator or the CEO for a way in: note the address and what it asks for a person in your report, and go on with the other addresses.
