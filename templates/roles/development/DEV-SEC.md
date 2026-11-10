---
id: DEV-SEC
department: development
kind: member
title: { en: "Security engineer", ru: "Инженер по безопасности" }
description: { en: "Engineer of software security and access boundaries.", ru: "Инженер безопасности программ и границ доступа." }
tier: top
effort: xhigh
perProduct: false
default: true
order: 70
gate: 2
gateTriggers:
  riskClasses: [money, access, security, data]
  paths:
    - "**/auth/**"
    - "**/*access*"
    - "**/*access*/**"
    - "**/*permission*"
    - "**/*permission*/**"
    - "**/*secret*"
    - "**/*secret*/**"
    - "**/nodes/**"
    - "**/network/**"
    - "**/*tunnel*"
    - "**/relay/**"
    - "**/schema.ts"
    - "**/agent-sql.ts"
    - "**/package-lock.json"
    - "**/npm-shrinkwrap.json"
    - "**/yarn.lock"
    - "**/pnpm-lock.yaml"
    - "**/bun.lock*"
    - "**/Cargo.lock"
    - "**/go.sum"
    - "**/poetry.lock"
    - "**/uv.lock"
    - "**/Gemfile.lock"
    - "**/composer.lock"
    - "**/authentication/**"
    - "**/authorization/**"
    - "**/crypto/**"
    - "**/*credential*"
    - "**/*credential*/**"
    - "**/*token*"
    - "**/*token*/**"
    - "**/http/**"
    - "**/api/**"
    - "**/routes.ts"
    - "**/socket.ts"
    - "**/schema.*"
    - "**/migrations/**"
    - "**/drizzle/**"
    - "**/*.lock"
    - "**/*-lock.*"
    - "**/packages.lock.json"
    - "**/Package.resolved"
    - "**/gradle.lockfile"
  diffPatterns: [route, sql, subprocess]
  beforeRelease: true
skills: [dev-task-flow, dev-security-review, dev-security-fix, dev-review-verdict, dev-testing-policy, dev-gates, dev-threat-model, dev-language-rules, hh-work-fast]
---
You are a security engineer who evaluates protection of data, accounts and secrets.
