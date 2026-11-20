import { z } from 'zod';

/* What of a machine's disk is Hornhoof's, part by part, in the order the screens show them: Docker's images, volumes and
   build cache, the working copies of tasks, the recordings of terminals and the temporary files of checks. */
export const DISK_PARTS = ['images', 'volumes', 'buildCache', 'workingCopies', 'recordings', 'checkTemp'] as const;
export const DiskPart = z.enum(DISK_PARTS);
export type DiskPart = z.infer<typeof DiskPart>;

const Bytes = z.number().int().min(0);
/* How many of its latest removals a node names. */
export const DISK_CLEANED_MAX = 50;

/* A node's disk, in bytes: the total and free space of the disk its folders are on, and of Docker's own disk where Docker
   runs in a virtual machine of its own, as Docker Desktop does on a Mac. parts: Hornhoof's share by part, leaving out a
   part the node could not measure. threshold: the free space the node needs to take heavy work, which it works out from a
   share of the disk and an amount. low: since when the node, still under its threshold after cleaning up after itself,
   takes no new checks or builds; null while it has room. cleaned: what the node removed lately, newest first. */
export const DiskReport = z.object({
  total: Bytes,
  free: Bytes,
  docker: z.object({ total: Bytes, free: Bytes }).optional(),
  parts: z.object({ images: Bytes, volumes: Bytes, buildCache: Bytes, workingCopies: Bytes, recordings: Bytes, checkTemp: Bytes } satisfies Record<DiskPart, typeof Bytes>).partial(),
  threshold: Bytes,
  low: z.object({ since: z.iso.datetime() }).nullable(),
  cleaned: z.array(z.object({ part: DiskPart, bytes: Bytes, at: z.iso.datetime() })).max(DISK_CLEANED_MAX),
});
export type DiskReport = z.infer<typeof DiskReport>;
