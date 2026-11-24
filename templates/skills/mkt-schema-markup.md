---
id: mkt-schema-markup
kind: procedure
sources: [coreyhaines31/marketingskills skills/schema/SKILL.md]
---
Use this ability to prepare and validate structured data for assigned pages. Inputs are the page content, public organization identity, intended schema types and any authorized editing scope.

1. Select types that match the visible page: for example Organization, WebSite, Product, SoftwareApplication, Article or BreadcrumbList. Use FAQPage only for questions and answers actually present; verify the current vocabulary and search-engine eligibility rather than assuming a rich result.
2. Prepare JSON-LD with true visible values: name, description, URL, logo, prices and dates. Never invent ratings, reviews or hidden claims.
3. Use the same approved organization name, logo and official links throughout the assigned pages.
4. Validate with the vocabulary's validator and relevant search-engine tests. Record page, tool, date, result and remaining warnings.
5. Return the markup, affected pages, evidence and proposed changes. Edit or ship code only when the assignment authorizes it and required task gates permit it.
6. If the assignment includes an already released page, inspect the available search reports for errors and propose corrections.

A validation result does not authorize changing a public page or widening access. A public change is marked in the department's git and waits for nobody's yes unless its department set an approval rule for it. Leave out a type whose fit cannot be established.
