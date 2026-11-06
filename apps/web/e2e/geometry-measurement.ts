export type GeometryMeasurement = {
  sourceSha: string; harnessSha: string; dataSha256: string; fontsSha256: string;
  caseId: string; engine: string; status: 'measured'; screenshotSha256: string; dpr: number;
  dimensions: Record<string, number>; icons: { id: string; dx: number; dy: number }[];
  clipping: unknown[]; horizontalOverflow: unknown[];
};

/* Contract placeholder for the remote RED. It cannot turn a raw capture into an accepted measurement. */
export function geometryMeasurement(record: unknown): GeometryMeasurement {
  void record;
  throw new Error('Geometry capture normalization is not implemented');
}
