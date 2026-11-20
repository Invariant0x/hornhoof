import { z } from 'zod';

/* What of a machine's disk is Hornhoof's, part by part, in the order the screens show them: Docker's images, containers,
   volumes and build cache, in the order Docker itself counts them, then the working copies of tasks, the recordings of
   terminals and the temporary files of checks. */
export const DISK_PARTS = ['images', 'containers', 'volumes', 'buildCache', 'workingCopies', 'recordings', 'checkTemp'] as const;
export const DiskPart = z.enum(DISK_PARTS);
export type DiskPart = z.infer<typeof DiskPart>;
/* The parts each node measures in its own folder, /data, apart from the rest, which the whole machine shares: the same in the
   report of every node on it. A node's folder is a Docker volume of its own, so where the volumes are measured these are
   inside them. */
export const NODE_DISK_PARTS = ['workingCopies', 'recordings', 'checkTemp'] as const satisfies readonly DiskPart[];

const Bytes = z.number().int().min(0);
/* How many of its latest removals a node names, and how many of the copies it keeps. */
export const DISK_CLEANED_MAX = 50;
export const DISK_KEPT_MAX = 50;

/* A node's disk, in bytes: the total and free space of the disk its folders are on, and the free space it needs there to
   take heavy work, which it works out from a share of the disk and an amount. docker: the same of Docker's own disk, where
   Docker keeps its data apart from that disk: inside a virtual machine of its own, as Docker Desktop does on a Mac, or, on
   Linux, with its data root on another filesystem; checks and builds fail when it is full whatever room the other has.
   parts: Hornhoof's share by part, leaving out a part the node could not measure. low: since when the node, with either
   disk still under its threshold after cleaning up after itself, takes no new checks or builds; the same while it stays
   short, and null once it has room again. cleaned: what the node removed in its cleaning of the last day, one entry for
   each part of each cleaning, newest first. kept: what its cleaning leaves because it can't be restored, biggest first, so a
   person sees where it is, how big and why: the agent's folder on the node (its employee id), the path inside that folder,
   the task it is for, and whether it has changes not committed or commits not pushed. An older node leaves it out. */
export const DiskReport = z.object({
  total: Bytes,
  free: Bytes,
  threshold: Bytes,
  docker: z.object({ total: Bytes, free: Bytes, threshold: Bytes }).optional(),
  parts: z.object({ images: Bytes, containers: Bytes, volumes: Bytes, buildCache: Bytes, workingCopies: Bytes, recordings: Bytes, checkTemp: Bytes } satisfies Record<DiskPart, typeof Bytes>).partial(),
  low: z.object({ since: z.iso.datetime() }).nullable(),
  cleaned: z.array(z.object({ part: DiskPart, bytes: Bytes, at: z.iso.datetime() })).max(DISK_CLEANED_MAX),
  kept: z
    .array(z.object({ part: DiskPart, agent: z.string().max(64), path: z.string().max(300), task: z.number().int().positive().nullable(), bytes: Bytes, why: z.enum(['uncommitted', 'unpushed']) }))
    .max(DISK_KEPT_MAX)
    .optional(),
});
export type DiskReport = z.infer<typeof DiskReport>;

/* The server adds this to the machine's disk view from keeper measurements. Bytes are part of Docker's volumes.
   Companies lists only those the server can name for the viewer. The node's own disk report carries no company names. */
export const MachineReplicas = z.object({
  count: z.number().int().min(0),
  bytes: Bytes,
  companies: z.array(z.object({ name: z.string(), bytes: Bytes })),
});
export type MachineReplicas = z.infer<typeof MachineReplicas>;
