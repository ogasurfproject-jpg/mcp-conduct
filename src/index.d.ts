export type ConductState = "verified" | "pending" | "held" | "watched" | "absent" | "unavailable";
export type ConductPolicy = "warn" | "measured" | "verified-only" | "off";

export interface ConductVerdict {
  endpoint: string;
  /** true only on a full pass of the latest scheduled measurement; null in every other case, never false. */
  verified: true | null;
  state: ConductState;
  measured_at?: string | null;
  record_sha256?: string | null;
  recompute_url?: string;
  conditions?: Record<string, boolean | null> | null;
  reason?: string;
  on_register?: boolean;
  gate_commit?: string;
  /** set when the gate itself could not be read; never a statement about the server */
  gate_error?: boolean;
  [k: string]: unknown;
}

export interface FreshVerdict extends ConductVerdict {
  /** true when this library recomputed record_sha256 from the verdict body and it matched */
  recomputed_matches: boolean;
  consent_source: "operator_list" | "well_known" | "requester" | "none" | null;
  record: Record<string, unknown>;
}

export interface Decision { allow: boolean; why: string; }

export interface ConductGateOptions {
  gate?: string;
  policy?: ConductPolicy;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  log?: ((message: string) => void) | null;
  userAgent?: string;
}

export interface ConductGate {
  check(endpoint: string): Promise<ConductVerdict>;
  checkMany(endpoints: string[]): Promise<ConductVerdict[]>;
  checkFresh(endpoint: string): Promise<FreshVerdict>;
  enforce(verdict: ConductVerdict, policy?: ConductPolicy): Decision;
  assert(endpoint: string, policy?: ConductPolicy): Promise<ConductVerdict>;
  guard<T extends { connect: (...args: any[]) => Promise<any> }>(client: T, endpoint?: string): T;
  decide(verdict: ConductVerdict, policy?: ConductPolicy): Decision;
  options: Required<ConductGateOptions>;
}

export class ConductBlocked extends Error {
  verdict: ConductVerdict;
  policy: ConductPolicy;
}

export function conductGate(options?: ConductGateOptions): ConductGate;
export function decide(verdict: ConductVerdict, policy: ConductPolicy): Decision;
export function recomputeRecordSha256(record: Record<string, unknown>): Promise<string | null>;
export const DEFAULT_GATE: string;
export const STATES: ConductState[];
export const POLICIES: ConductPolicy[];
