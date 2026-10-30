export interface LinkedPhotoFacts {
  photoCount: number;
  withoutGps: number;
  cameras: Array<{ make: string | null; model: string | null; photoCount: number }>;
  dimensions: Array<{ width: number; height: number; photoCount: number }>;
}

export interface LinkSourceView {
  url: string | null;
  /** Size reported by this check. Stored addresses are not checked again on a read. */
  size: number | null;
  facts: LinkedPhotoFacts | null;
  factsRunId: number | null;
}
