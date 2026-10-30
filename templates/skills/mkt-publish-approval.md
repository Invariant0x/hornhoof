---
id: mkt-publish-approval
title: { en: "Publish approval", ru: "Одобрение публикации" }
description: { en: "Lets a public text, post or page out only after two reviews, on brand and on claims, and the CEO's approval.", ru: "Выпускает публичный текст, пост или страницу только после двух проверок, по бренду и по фактам, и одобрения CEO." }
kind: gate
sources: [affaan-m/ECC skills/operator-approval-loop/SKILL.md]
---
Nothing goes public without this gate: posts, replies, articles, pages, emails to lists, ads, comments in communities, profile changes. The author never runs it on their own work.

1. **Freeze the draft**: the exact final text and images, where it goes (network, account, page), when, and in which language. Two languages are two drafts.
2. **Two reviews**, each in a fresh context on the fast tier, on a provider other than the author's where one is available. They work independently and do not see each other's notes:
   - **Brand**: voice, terms and tone match the product marketing context; spelling and grammar are right for the language; nothing generic or machine-sounding; images and links are right.
   - **Claims**: every fact, number, comparison and promise has a source in the context or a link; nothing about competitors that cannot be proved; no promise on price, dates or results the CEO has not made; no customer named without permission; no secrets or private data.
   Each returns pass or fail with findings. Both must pass. A fail goes back to the author through hh-fix-loop, and both reviews run again on the new version.
3. **CEO approval**: send the frozen draft, both review results and the publishing plan to the CEO through the orchestrator. Wait for an explicit approval; silence is not approval.
4. **Publish exactly what was approved**. Any change after approval, even one word, needs a new approval.
5. **Record it**: what went out, where, when, the link, who approved it.

If something already public turns out to be wrong, tell the CEO at once with a proposed correction. Do not edit or delete it without approval.
