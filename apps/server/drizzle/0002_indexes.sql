CREATE INDEX "invites_person_id" ON "invites" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "jobs_subscription_id" ON "jobs" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "people_company_id" ON "people" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "sessions_person_id" ON "sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "subscriptions_owner_person_id" ON "subscriptions" USING btree ("owner_person_id");