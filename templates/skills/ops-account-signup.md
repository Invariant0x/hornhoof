---
id: ops-account-signup
title: { en: "Account sign-up", ru: "Регистрация в сервисе" }
description: { en: "Prepares a sign-up with an outside service and finishes it only with the CEO's approval and help.", ru: "Готовит регистрацию во внешнем сервисе и завершает ее только с одобрения и при участии CEO." }
kind: procedure
sources: []
---
Every account the company opens is approved by the CEO first. Prepare the request:

- **Service and plan**: name, website, plan, price per month and per year.
- **Why**: the request it serves and the departments that will use it.
- **Owner**: the company address or the person it is registered to, as the CEO decides.
- **Data**: what company or customer data will go into it, and where the service keeps it.
- **Vendor review**: the result of ops-vendor-review.
- **Exit**: how to cancel and how to export the data.

Send it to your head, who asks the CEO through the orchestrator. Do not start a sign-up before the approval arrives.

During the sign-up:

- Fill the forms only with the details the CEO approved.
- Two-factor codes, phone or email confirmations and identity checks go to the CEO. Ask and wait; never guess or reuse an old code.
- Payment details are entered by the CEO. Never type, store or ask for card numbers.
- If a CAPTCHA or another bot check appears, stop and hand that step to the CEO. Never solve it with a service, a script or a trick.
- Read the terms that matter: auto-renewal, data use, limits on automated access. Report anything unusual.

When it is done, move every credential to the secret store at once (ops-credential-vault) and add the account to the register.
