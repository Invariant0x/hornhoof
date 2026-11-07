---
id: ops-account-signup
title: { en: "Account sign-up", ru: "Регистрация в сервисе" }
description: { en: "Prepares a sign-up with an outside service and finishes it only with the CEO's approval and help.", ru: "Готовит регистрацию во внешнем сервисе и завершает ее только с одобрения и при участии CEO." }
kind: procedure
sources: []
---
Prepare a sign-up for the service named in the assignment. Every new account needs the CEO's approval before sign-up starts. The request includes:

- Service, website, plan and verified monthly and annual price.
- Purpose, intended users and the owner the CEO will approve.
- Data to be shared, storage country, training use, export and deletion options.
- Vendor evidence: terms permit automated access, access can be narrowly scoped, security controls, renewal and cancellation terms, reliability and alternatives. Link the vendor's own sources and mark unknowns.
- How to cancel and export the data.

Use the authorized company route to obtain the CEO's approval for that exact service, plan, owner and data use. Approval for one request does not approve a changed price, plan or scope.

During sign-up:

- Fill forms only with approved details.
- Leave two-factor codes, phone or email confirmation and identity checks to the CEO; wait for the current confirmation, never reuse an old code.
- The CEO enters payment details. Never type, store or request card numbers.
- Stop at a CAPTCHA or other bot check and hand that step to the CEO. Never bypass it with a service, script or trick.
- Read auto-renewal, data use and automated-access terms; report any difference from the approved request before continuing.

Put resulting credentials directly into the company's secret store under service/account/purpose names, with owner, scope and creation date. Never copy values into messages, files, logs or screenshots. Record the account's owner, cost, renewal, limits and secret entry names in the designated register.

Any related access, root, permissions or secrets change requires an independent Security engineer's pass on the exact candidate before shared merge, including urgent, small, named work and review fixes. Skill selection cannot grant permissions or waive human approval.
