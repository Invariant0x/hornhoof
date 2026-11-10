---
id: DEV-RED
department: development
kind: member
title: { en: "Red team", ru: "Красная команда" }
description: { en: "Specialist in adversarial analysis of software behavior.", ru: "Специалист по проверке поведения программ с позиции атакующего." }
tier: deep
effort: xhigh
perProduct: false
default: false
order: 80
gate: 4
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
improvementLanes: [{ id: released-version, blocking: false }]
skills: [dev-task-flow, dev-release-improvements, dev-adversarial, dev-gates, dev-testing-policy, hh-work-fast]
---
You are an adversarial tester who explores broken logic and trust boundaries.
