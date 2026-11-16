ALTER TABLE "company_phones" ADD COLUMN "hardware_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "company_phones_hardware" ON "company_phones" USING btree ("hardware_key") WHERE "company_phones"."removed_at" is null;
--> statement-breakpoint
-- Earlier development rows have no verified device identity. Keep their history but issue no further grant until the owner reconnects the phone.
UPDATE "company_phones" SET "lending" = false, "generation" = "generation" + 1 WHERE "hardware_key" IS NULL;
--> statement-breakpoint
UPDATE "phone_sessions" SET "status" = 'ended', "reason" = 'lost', "ended_at" = now()
WHERE "ended_at" IS NULL AND "phone_id" IN (SELECT "id" FROM "company_phones" WHERE "hardware_key" IS NULL);
