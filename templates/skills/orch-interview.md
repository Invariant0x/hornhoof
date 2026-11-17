---
id: orch-interview
title: { en: "Ask before you lay out", ru: "Спросить, прежде чем раскладывать" }
description: { en: "Finds out what the CEO wants and why before a turn or a change, with as few questions as it takes.", ru: "Выясняет, чего хочет CEO и зачем, прежде чем раскладывать ход или менять компанию, задавая как можно меньше вопросов." }
kind: procedure
sources: [obra/superpowers skills/brainstorming/SKILL.md]
---
You can clarify the intended result before planning an authorized change.

At first-contact, ask "What would you like me to do?" and show the short menu for the company's starter kit. Offer real work that those departments can do, plus Telegram and a personal assistant. Give each offer one plain line. For a new person who joined an existing company, start with what they can use and ask the same question. Once they pick an offer, start it. Ask only for the next detail you need.

- **Telegram**: read your card at GET /api/agents/orchestrator and look for an existing bot. If none is connected, look in the company vault for its bot token and connect it yourself with PUT /api/agents/orchestrator/telegram. Use a company Telegram sign-in from the vault to set up the bot through BotFather if available. When Telegram needs a person's account or action, walk them through the one step they need to take, starting with /newbot if there is no bot yet. Keep the token in the vault or the bot's secure setup field. Connect the person's Telegram username or numeric ID to their People record with PATCH /api/people/<id>, then show the bot link and ask them to press Start or send a message. When the bot and their link are ready, say they can write to you there. Never put a token in a chat reply.
- **Personal assistant**: look up the person by id and check their existing assistants before making one. Use POST /api/people/assistants with that person as owner and the program they use, and set its plan when known. Its own agent gets the stock Personal assistant instructions. Its owner's messages come through the orchestrator in that person's name. Guide the person through any setup only they can finish, one step at a time, and keep assistant keys out of chat.

Before laying out a turn or changing the company, make sure you know what the person wants and why. Read what the company already says about its work and products before asking for more.

1. Read what was said, the notebook and the turns first. Never ask what they already tell.
2. When something that changes what gets built is missing, ask one question at a time in plain words, one or two follow-ups at most, then move on. A guess the CEO can correct, like "I take it this is for the school release?", often beats an open question.
3. Ask about the result and why it matters, not about how to build it: the assigned owner decides how.
4. Stop asking as soon as you could write each task's "done when" line.
5. Say back in one or two lines what you understood, then act. Write each decision into the notebook with remember.
