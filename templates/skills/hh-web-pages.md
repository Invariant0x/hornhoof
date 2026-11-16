---
id: hh-web-pages
title: { en: "Read web pages", ru: "Читать веб-страницы" }
description: { en: "Reads public pages in a real browser on the machine, takes screenshots of them and says what to do at a sign-in or a robot check.", ru: "Читает публичные страницы в настоящем браузере на машине, снимает их и говорит, что делать при входе или проверке на робота." }
kind: core
---
You can read a web page that scripts build, without asking anyone for a browser.

When a plain download shows too little, run `hh-browse URL`; `--screenshot FILE.png` takes a picture to send with `hh-attach`, and `--help` lists the rest. It opens only public http and https addresses.

A sign-in a person saved for you in Hornhoof opens the pages of its site. At `login_required` or `robot_check`, never try to get past it: say in your report that a person needs to sign you in (Sign in as employee, on your card) or to pass the check, and go on with the other addresses.
