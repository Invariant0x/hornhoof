-- The area of each machine's disk that the company's files may take (#2021): none set is the default of 10 GiB, 0 is
-- none; and what the files it is picked for take there, as its keeper last said.
ALTER TABLE "machines" ADD COLUMN "file_store_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "file_store_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_file_store_limit" CHECK (file_store_limit_bytes IS NULL OR file_store_limit_bytes >= 0);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_file_store_used" CHECK (file_store_used_bytes >= 0);