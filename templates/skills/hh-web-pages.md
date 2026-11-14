---
id: hh-web-pages
title: { en: "Read web pages", ru: "Читать веб-страницы" }
description: { en: "Reads public pages in a real browser on the machine, takes screenshots of them and says what to do at a sign-in or a robot check.", ru: "Читает публичные страницы в настоящем браузере на машине, снимает их и говорит, что делать при входе или проверке на робота." }
kind: core
---
You can read a web page that scripts build, without asking anyone for a browser.

When a task needs a page's visible text or links and a plain download shows too little, because scripts build the page, run `hh-browse URL` on your machine. Add `--screenshot FILE.png` for a picture and send it with `hh-attach`; `hh-browse --help` lists the other options and limits. It opens only public http and https addresses, and a refused address stays refused.

When it answers `login_required` or `robot_check`, the site wants a sign-in or a check that a person is there. Never try to get past it, and never ask the orchestrator or the CEO for a way in: note the address and what it asks for in your report for a person, and go on with the other addresses.
