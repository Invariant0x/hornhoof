---
id: mkt-schema-markup
title: { en: "Structured data", ru: "Структурированные данные" }
description: { en: "Adds schema.org markup so search engines understand what each page is about.", ru: "Добавляет разметку schema.org, чтобы поисковики понимали, о чем каждая страница." }
kind: procedure
sources: [coreyhaines31/marketingskills skills/schema/SKILL.md]
---
1. For each page type, pick the schema.org types that match what is really on the page: Organization and WebSite on the home page, SoftwareApplication or Product on product pages, Article on posts, FAQPage only where the questions and answers are visible, BreadcrumbList for navigation.
2. Write it as JSON-LD in the page head. Fill in only true values that the page shows: name, description, URL, logo, prices, dates. Never add ratings or reviews that are not on the page and real.
3. Use one Organization identity everywhere, with the same name, logo and links to official profiles.
4. Validate each page with the schema.org validator and the search engines' rich result tests, and keep the output.
5. Hand the markup to your head as a change for development, with the list of pages and the validation output. It ships through development's own gates.
6. After release, check the search engines' reports for markup errors and fix them.

Markup that misstates a page can get the site penalised. When you are unsure whether a type fits, leave it out.
