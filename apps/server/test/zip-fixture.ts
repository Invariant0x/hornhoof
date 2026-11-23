import { crc32, deflateRawSync } from 'node:zlib';

/* Zip archives written byte by byte, so a test can make one that is plain or one that lies: about its sizes, its names,
   its kind of packing or where its entries lie. */
export type ZipFixtureEntry = {
  name: string;
  data: Buffer | string;
  /* 0 stored, 8 deflate, anything else for a packing no reader should take. */
  method?: number;
  flags?: number;
  /* The upper 16 bits carry a Unix mode when madeBy says Unix (3). */
  externalAttrs?: number;
  madeBy?: number;
  /* What the headers say instead of the truth. */
  size?: number;
  compressedSize?: number;
  crc?: number;
  diskStart?: number;
  /* The name the local header gives, where it differs from the central directory's. */
  localName?: string;
  /* Where the central directory says the entry lies, instead of where it does. */
  offset?: number;
};

export type ZipFixtureOptions = { comment?: string; after?: Buffer; disk?: number; zip64Locator?: boolean; count?: number };

const bytesOf = (data: Buffer | string) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data);

export function zipOf(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = bytesOf(entry.data);
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const sum = entry.crc ?? crc32(data) >>> 0;
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(entry.compressedSize ?? packed.length, 18);
    local.writeUInt32LE(entry.size ?? data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    localName.copy(local, 30);
    const head = Buffer.alloc(46 + name.length);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(((entry.madeBy ?? 3) << 8) | 20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.flags ?? 0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(0x00210000, 12);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(entry.compressedSize ?? packed.length, 20);
    head.writeUInt32LE(entry.size ?? data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(entry.diskStart ?? 0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE((entry.externalAttrs ?? (0o100644 << 16)) >>> 0, 38);
    head.writeUInt32LE(entry.offset ?? offset, 42);
    name.copy(head, 46);
    parts.push(local, packed);
    central.push(head);
    offset += local.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const locator = Buffer.alloc(options.zip64Locator ? 20 : 0);
  if (options.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const end = Buffer.alloc(22 + comment.length);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.disk ?? 0, 4);
  end.writeUInt16LE(options.disk ?? 0, 6);
  end.writeUInt16LE(options.count ?? entries.length, 8);
  end.writeUInt16LE(options.count ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  comment.copy(end, 22);
  return Buffer.concat([...parts, directory, locator, end, options.after ?? Buffer.alloc(0)]);
}
