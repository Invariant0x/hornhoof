---
id: mkt-seo-audit
title: { en: "Search audit", ru: "Поисковый аудит" }
description: { en: "Checks the company's site for the technical, content and link problems that keep it out of search results.", ru: "Проверяет сайт компании на технические, содержательные и ссылочные проблемы, которые мешают ему в поиске." }
kind: checklist
sources: [coreyhaines31/marketingskills, anthropics/knowledge-work-plugins]
---
Use this ability to audit an assigned site or page set and rank findings by likely effect on discovery. Inputs are the target audience, markets, page scope, permitted inspection tools and available analytics.

**Technical**
- Check response codes, broken internal links, redirect chains and one canonical URL per page.
- Compare robots.txt and sitemap settings with the intended indexing policy; do not open excluded content by assumption.
- Check whether main content, title and description are present in HTML.
- Measure phone performance, including Largest Contentful Paint, layout shift and interaction latency, against the current criteria named in the assignment. Record the measured values and source of the thresholds.
- Check reciprocal language annotations for supported versions.

**Content**
- Identify the intent and main phrase for each page, and overlapping pages serving the same intent.
- Check a useful title, one main heading and descriptive section headings against actual search presentation.
- Compare the answer with relevant current results; identify thin, duplicate and outdated content.

**Links**
- Check descriptive internal links to important pages.
- Identify relevant sites linking to alternatives but not to the assigned site, without contacting them.

Return each page, evidence, impact, proposed fix and required capability, marking uncertainty. An audit authorizes no publication, deletion or account creation. Text and code changes follow their assigned task gates; public content is marked in the department's git and waits for nobody's yes unless its department set an approval rule for it.
