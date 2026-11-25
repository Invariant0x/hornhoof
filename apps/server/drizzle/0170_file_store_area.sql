-- The area of each machine's disk that the company's files may take (#2021): none set is the default of 10 GiB, 0 is
-- none; what the files it keeps take there, and the free and whole room of the disk they lie on, as its keeper last
-- said. Each a whole number JavaScript counts exactly.
ALTER TABLE "machines" ADD COLUMN "file_store_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "file_store_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "files_disk_free" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "files_disk_total" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_file_store_limit" CHECK (file_store_limit_bytes IS NULL OR (file_store_limit_bytes >= 0 AND file_store_limit_bytes <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_file_store_used" CHECK (file_store_used_bytes >= 0 AND file_store_used_bytes <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_files_disk" CHECK ((files_disk_free IS NULL OR files_disk_free BETWEEN 0 AND 9007199254740991) AND (files_disk_total IS NULL OR files_disk_total BETWEEN 0 AND 9007199254740991));
