---
id: mkt-publish-approval
title: { en: "Publish approval", ru: "Одобрение публикации" }
description: { en: "Routes public posts, pages and announcements through the server outbound gateway, published catalog sources and per-item owner approval.", ru: "Проводит публичные посты, страницы и объявления через серверный шлюз исходящих, опубликованный каталог и поштучное одобрение владельца." }
kind: gate
sources: [affaan-m/ECC skills/operator-approval-loop/SKILL.md]
---
Every public post, announcement, newsletter or external page from Marketing goes through the server outbound gateway (`"outbound_submit"` and `"outbound_status"`). Publishing account credentials stay on the server and are never exposed to agents.

1. **Build from published catalog sources**: select the registered public audience, language and published template, claim, price, terms and `https:` link revisions. Two languages are two separate submissions; never substitute another language silently.
2. **Server verification and independent checks**: the server renders the exact bytes, blocks unapproved claims, prices, secrets or personal data, enforces channel limits, and runs certified independent-vendor model checks in a fresh context.
3. **Per-item approval**: public publication is irreversible, so every public item requires explicit per-item approval of its exact rendered content from the department owner (or the CEO / CEO delegate when no department owner is set). Approach-level rules never waive per-item approval for public posts.
4. **Publish and track safely**: once approved, the server dispatches the frozen bytes without modification. Any wording or source change creates a new revision that needs a new approval. If `"outbound_status"` reports `unknown`, do not republish until the destination is checked. If a live post contains an error, notify the department owner or the CEO immediately with a proposed correction; never delete or overwrite public records without approval.
