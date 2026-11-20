import { z } from 'zod';

/* What of a machine's disk is Hornhoof's, part by part, in the order the screens show them: Docker's images, containers,
   volumes and build cache, in the order Docker itself counts them, then the working copies of tasks, the recordings of
   terminals and the temporary files of checks. */
export const DISK_PARTS = ['images', 'containers', 'volumes', 'buildCache', 'workingCopies', 'recordings', 'checkTemp'] as const;
export const DiskPart = z.enum(DISK_PARTS);
export type DiskPart = z.infer<typeof DiskPart>;

const Bytes = z.number().int().min(0);
/* How many of its latest removals a node names. */
export const DISK_CLEANED_MAX = 50;

/* A node's disk, in bytes: the total and free space of the disk its folders are on, and the free space it needs there to
   take heavy work, which it works out from a share of the disk and an amount. docker: the same of Docker's own disk, where
   Docker keeps its data apart from that disk: inside a virtual machine of its own, as Docker Desktop does on a Mac, or, on
   Linux, with its data root on another filesystem; checks and builds fail when it is full whatever room the other has.
   parts: Hornhoof's share by part, leaving out a part the node could not measure. low: since when the node, with either
   disk still under its threshold after cleaning up after itself, takes no new checks or builds; the same while it stays
   short, and null once it has room again. cleaned: what the node removed in its cleaning of the last day, one entry for
   each part of each cleaning, newest first. */
export const DiskReport = z.object({
  total: Bytes,
  free: Bytes,
  threshold: Bytes,
  docker: z.object({ total: Bytes, free: Bytes, threshold: Bytes }).optional(),
  parts: z.object({ images: Bytes, containers: Bytes, volumes: Bytes, buildCache: Bytes, workingCopies: Bytes, recordings: Bytes, checkTemp: Bytes } satisfies Record<DiskPart, typeof Bytes>).partial(),
  low: z.object({ since: z.iso.datetime() }).nullable(),
  cleaned: z.array(z.object({ part: DiskPart, bytes: Bytes, at: z.iso.datetime() })).max(DISK_CLEANED_MAX),
});
export type DiskReport = z.infer<typeof DiskReport>;
