---
id: ops-vendor-review
title: { en: "Vendor review", ru: "Проверка поставщика" }
description: { en: "Checks an outside service for cost, data handling, terms and lock-in before the company signs up.", ru: "Проверяет внешний сервис на стоимость, обращение с данными, условия и риск привязки до регистрации." }
kind: checklist
sources: [anthropics/knowledge-work-plugins operations/skills/vendor-review/SKILL.md, anthropics/knowledge-work-plugins legal/skills/vendor-check/SKILL.md]
---
Answer each point from the vendor's own pages and give the link. Write "unknown" where you cannot find it; never fill a gap with a guess.

- [ ] **Need**: what the service does for us, and the cheaper or already paid alternatives you compared.
- [ ] **Cost**: price per month and year, per seat or per use, what happens past the limits, taxes, free tier.
- [ ] **Terms**: contract length, auto-renewal, cancellation, notice of price changes.
- [ ] **Data**: what data we put in, the country it is stored in, whether it is used for training, how to export and delete it.
- [ ] **Security**: two-factor sign-in, roles and permissions, API keys with scopes, an audit log.
- [ ] **Automation**: the terms allow API and agent use. A ban on automated access is a blocker.
- [ ] **Reliability**: status page, history of outages, support hours.
- [ ] **Lock-in**: how hard it is to leave, export formats.
- [ ] **Legal**: anything that needs a lawyer, such as customers' personal data or payments, is flagged for the CEO.

End with a verdict: use, use with conditions (list them), or do not use, and the one reason that decides it.
