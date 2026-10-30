---
id: mkt-seo-audit
title: { en: "Search audit", ru: "Поисковый аудит" }
description: { en: "Checks the company's site for the technical, content and link problems that keep it out of search results.", ru: "Проверяет сайт компании на технические, содержательные и ссылочные проблемы, которые мешают ему в поиске." }
kind: checklist
sources: [coreyhaines31/marketingskills, anthropics/knowledge-work-plugins]
---
Audit a site or a set of pages and rank what you find by its effect on traffic.

**Technical**
- [ ] Pages return 200; no broken internal links or redirect chains; one canonical URL per page.
- [ ] robots.txt and the sitemap let in the pages that should rank and keep out the ones that should not.
- [ ] Main content, the title and the meta description are in the HTML, not only added by scripts.
- [ ] Core Web Vitals are in the good range on phones: Largest Contentful Paint under 2.5 s, layout shift under 0.1, interaction under 200 ms.
- [ ] Language versions are marked with hreflang and point to each other.

**Content**
- [ ] Each page serves one search intent with one main phrase; no two pages compete for the same one.
- [ ] Title under about 60 characters with the phrase near the start; one H1; headings that describe their sections.
- [ ] The page answers the query better than the current top results: compare it with them.
- [ ] Thin, duplicate or outdated pages are listed to merge, update or remove.

**Links**
- [ ] Important pages get internal links with descriptive text.
- [ ] List the sites that link to competitors but not to us.

For each finding give the page, the evidence (tool output or a screenshot), the fix, and who makes it: marketing for text, development for code, both through your head.
