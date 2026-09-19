export type AssetStatus = 'draft' | 'in_review' | 'approved' | 'archived';
export type AssetKind = 'image' | 'video' | 'document';

/** Failure codes that can appear in a per-id bulk status row. */
export type BulkFailureCode =
  | 'not_found'
  | 'legal_hold'
  | 'conflict'
  | 'invalid_status'
  | 'bad_request'
  | 'too_many_ids';

export interface Owner {
  id: string;
  name: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  status: AssetStatus;
  tags: string[];
  collectionId: string;
  owner: Owner;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  hasThumbnail: boolean;
}

export interface AssetPage {
  items: Asset[];
  total: number;
  nextCursor: string | null;
}

export type AssetSort =
  | 'updatedAt:desc'
  | 'updatedAt:asc'
  | 'name:asc'
  | 'name:desc'
  | 'sizeBytes:desc'
  | 'createdAt:desc';

export interface AssetQuery {
  q?: string;
  status?: AssetStatus[];
  kind?: AssetKind[];
  tag?: string[];
  collectionId?: string;
  owner?: string;
  sort?: AssetSort;
  limit?: number;
  cursor?: string;
}

/** A single per-id row inside a bulk status response (200 or 207). */
export type BulkItemResult =
  | { id: string; ok: true; asset: Asset }
  | { id: string; ok: false; code: BulkFailureCode; message?: string };

export interface BulkResult {
  results: BulkItemResult[];
  applied: number;
  failed: number;
}

/** Describes a bulk run after all chunks and business-level retries settle. */
export interface BulkOutcome {
  okIds: string[];
  failed: Array<{ id: string; code: BulkFailureCode; message?: string }>;
}
