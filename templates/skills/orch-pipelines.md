---
id: orch-pipelines
title: { en: "Set up ready pipelines", ru: "Настроить готовый порядок работы" }
description: { en: "Chooses and applies a ready pipeline for the work a person describes.", ru: "Подбирает и настраивает порядок работы под задачу человека." }
kind: procedure
---
Ask what result the person wants, then offer the closest pipeline in plain words: "For this, video editing gives you a rough cut, a review and a final export." You can set up a whole kind of work like video editing in one step. Start with the department that can do the work. Use company to find it or build_structure to create it if needed. Read pipeline_catalog for the live choices, their stages and the roles that own them. The first item in each list below is the stock default.

Use apply_pipeline with the department id, the pipeline key and mode add when the new work sits alongside the usual work. Use set_default when the person wants the new pipeline for the department's usual work. The selected pipeline becomes the default for new work and earlier work keeps its own pipeline. Read the result before you report what you set up. Use create_task with the pipeline id to start work on a pipeline added alongside the default.

Use the routes and one-shot briefs in the catalog when you lay out the work. Give tasks to the role responsible for each result and link the handoffs. Name the stage id if one role owns more than one stage. If a role is vacant, ask the head to assign the work to a person who can do it. The head follows the people responsible for the department. Departments send, post and talk to people as part of their work. Agents sign in with the vault. A person pays or signs for the company. Only irreversible deletion needs a yes from the CEO.

### Operations

- `operations-requests` Operations requests. For everyday requests to set up tools, accounts or access.
- `operations-incidents` Service recovery. For a stopped service, stuck program or failed delivery.
- `operations-integrations` Connect a tool. For connecting a shared tool, mailbox or outside service.
- `operations-phone-handoff` Company phone setup. For getting a company phone ready for work in its apps.

### Development

- `development-changes` Software changes. For building a feature or fixing a product problem.
- `development-docs` Technical guides. For writing instructions or updating examples that people use.
- `development-release` Release a product. For taking a checked set of changes to the people who use it.

### Design

- `design-requests` Design requests. For new screens and other everyday design work.
- `design-brand-assets` Brand assets. For illustrations, presentation pieces or other reusable brand material.
- `design-video-editing` Video editing. For turning existing footage into a finished video.

### Marketing

- `marketing-campaigns` Marketing work. For a campaign, announcement or a piece of content.
- `marketing-daily-series` Daily signed content. For a daily series published in a person’s name with their agreement.
- `marketing-news-videos` Short news videos. For making short videos from verified news or product updates.
- `marketing-press-pool` Press outreach. For building a press list and pitching one story to relevant outlets.

### Sales

- `sales-opportunities` Sales opportunities. For following up with interested buyers through a decision.
- `sales-outreach` Email outreach. For finding suitable contacts and starting conversations by email.
- `sales-proposals` Sales proposals. For putting a price and work plan in front of a buyer who asked for them.

### Business development

- `business-development-opportunities` Business opportunities. For testing whether a new opportunity is worth pursuing.
- `business-development-market-scan` Market scan. For comparing demand, competing offers and gaps in a market.
- `business-development-partners` Partner search. For finding organizations that could work with the company.

### Support

- `support-requests` Support requests. For answering everyday questions and resolving customer problems.
- `support-triage` Ticket triage. For a backlog or rush of tickets that need sorting and assignment.
- `support-knowledge` Help articles. For turning a recurring question into an answer others can reuse.

### Finance

- `finance-records` Finance requests. For routine bookkeeping, bills and financial questions.
- `finance-monthly-close` Monthly close. For closing the books and explaining differences at month end.
- `finance-cash-plan` Cash planning. For seeing what money is expected in and what bills are coming due.

### Home devices

- `devices-requests` Home device help. For checking or fixing a device already in the home.
- `devices-cleanup` Device cleanup. For freeing space and clearing junk on a TV or other home device.
- `devices-network` Home network check. For slow Wi-Fi or devices dropping off the home network.

### Household

- `household-requests` Household requests. For organizing everyday requests and following through on them.
- `household-bills` Household bills. For gathering bills and telling the person paying what is due.
- `household-supplies` Household supplies. For finding what the household needs and arranging a restock.
