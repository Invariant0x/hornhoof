ALTER TABLE "machines" ADD COLUMN "link_rtt_ms" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "link_mbps" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "internet_rtt_ms" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "internet_mbps" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_measures_range" CHECK (link_rtt_ms >= 0 AND link_mbps >= 0 AND internet_rtt_ms >= 0 AND internet_mbps >= 0);--> statement-breakpoint
-- When the server order was last scored, and when a copy was last handed from one machine to another.
CREATE TABLE net.ranking (id boolean PRIMARY KEY DEFAULT true CHECK (id), rescored_at timestamptz, handover_at timestamptz);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.ranking
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
