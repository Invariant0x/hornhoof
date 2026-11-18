---
id: vid-model-access
title: { en: "Video model access", ru: "Доступ к видеомодели" }
description: { en: "Sets up the video generation API key in the vault with a spend limit, says which providers work and keeps the agents' own plans as they are.", ru: "Подключает ключ API для генерации видео через хранилище с лимитом трат, говорит, какие поставщики подходят, и оставляет агентам их обычные подписки." }
kind: procedure
sources: []
---
You can give the department a working video model through an API key and keep its spending inside a limit.

**What works.** Agents reach a video model only through an API with a key. Two kinds of provider work: an aggregator API that serves several video models under one key, and the API of the model's maker itself. Choose one that offers image-to-video, so that every shot starts from a reference frame, and that bills by use. The consumer subscriptions of video sites and apps give no API, so agents cannot use them. Tell people plainly that such a subscription does not work for the department and that an API key is needed.

**The agents' own plans.** The key is for generation only. Every employee of the department keeps its ordinary subscription for thinking and writing. The video key is never added as an employee's plan, and no plan is changed for it.

**Setting it up.** When the department starts and the vault holds no video generation key, ask the person responsible for the department once, in plain words, for three things: an API key of a provider of the kinds above, saved in the vault under a name that says it is the video generation key; a spend limit on the provider's own account where it offers one; and the department's spend limit for video generation. The key and the payment are that person's, and only they can give them. Never ask for the key in a chat, a task or a file, and never write it into one. Find it with vault_entries and read it with vault_entry when a call needs it, and pass it to the call through an environment variable or standard input, never in a command line that is logged.

**Checking the key.** Once it is saved, make one short draft at low resolution from a test frame and record its cost, so that the key, the model and the price are known before real work starts.

**Keeping the limit.** Before a video's generation starts, estimate its cost from the shot count, the drafts per shot, the length of each shot and the provider's price, and ask for it with request_approval on the spend channel with that amount. The department's rule decides whether it waits for anyone. Record the cost of each call as it is made. When spending would pass a limit, stop generation and ask the person responsible; only the person who set a limit raises it. A call refused for money or a limit is reported, never retried around.

**Without a working key** the department makes no video. It never delivers a slideshow of still images as video in its place; it says that the video waits for a key.
