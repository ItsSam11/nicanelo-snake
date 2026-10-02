import { createHash } from "node:crypto";
import {
  BEHAVIOR_DIMENSIONS,
  type BehaviorScores,
} from "../model/behavior-features.js";
import {
  BEHAVIOR_PROFILE_VERSION,
  type SnakeBehaviorProfile,
} from "./behavior-profile.js";

export const PROFILE_REFERENCE_SCHEMA_VERSION = 1 as const;

export interface ProfileReference {
  schemaVersion: typeof PROFILE_REFERENCE_SCHEMA_VERSION;
  referenceVersion: string;
  profileVersion: typeof BEHAVIOR_PROFILE_VERSION;
  createdAt: string;
  sampleCount: number;
  distributions: Record<keyof BehaviorScores, readonly number[]>;
}

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1;
}

export function buildProfileReference(
  profiles: readonly SnakeBehaviorProfile[],
  referenceVersion: string,
  createdAt = new Date().toISOString(),
): ProfileReference {
  if (referenceVersion.trim().length === 0) {
    throw new Error("referenceVersion must be non-empty");
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("createdAt must be an ISO timestamp");
  }
  if (profiles.length === 0) {
    throw new Error("Cannot build a profile reference without profiles");
  }
  return {
    schemaVersion: PROFILE_REFERENCE_SCHEMA_VERSION,
    referenceVersion,
    profileVersion: BEHAVIOR_PROFILE_VERSION,
    createdAt,
    sampleCount: profiles.length,
    distributions: Object.fromEntries(
      BEHAVIOR_DIMENSIONS.map((dimension) => [
        dimension,
        profiles.map((profile) => profile.scores[dimension]).sort((a, b) => a - b),
      ]),
    ) as unknown as ProfileReference["distributions"],
  };
}

export function parseProfileReference(value: unknown): ProfileReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid profile reference");
  }
  const candidate = value as Partial<ProfileReference>;
  const distributions = candidate.distributions;
  if (
    candidate.schemaVersion !== PROFILE_REFERENCE_SCHEMA_VERSION ||
    candidate.profileVersion !== BEHAVIOR_PROFILE_VERSION ||
    typeof candidate.referenceVersion !== "string" ||
    candidate.referenceVersion.trim().length === 0 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !Number.isSafeInteger(candidate.sampleCount) ||
    (candidate.sampleCount ?? 0) < 1 ||
    typeof distributions !== "object" || distributions === null
  ) {
    throw new Error("Invalid profile reference");
  }
  for (const dimension of BEHAVIOR_DIMENSIONS) {
    const values = distributions[dimension];
    if (
      !Array.isArray(values) || values.length !== candidate.sampleCount ||
      !values.every(finiteScore) ||
      values.some((item, index) => index > 0 && item < (values[index - 1] ?? 0))
    ) {
      throw new Error(`Invalid profile reference distribution ${dimension}`);
    }
  }
  return candidate as ProfileReference;
}

export function serializeProfileReference(
  reference: Readonly<ProfileReference>,
): string {
  return `${JSON.stringify(reference, null, 2)}\n`;
}

export function profileReferenceDigest(
  reference: Readonly<ProfileReference>,
): string {
  return `sha256:${createHash("sha256")
    .update(serializeProfileReference(reference))
    .digest("hex")}`;
}

function percentile(value: number, distribution: readonly number[]): number {
  let low = 0;
  let high = distribution.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((distribution[middle] ?? Number.POSITIVE_INFINITY) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Number((low / Math.max(1, distribution.length)).toFixed(6));
}

export function profilePercentiles(
  scores: Readonly<BehaviorScores>,
  reference: Readonly<ProfileReference>,
): BehaviorScores {
  return Object.fromEntries(
    BEHAVIOR_DIMENSIONS.map((dimension) => [
      dimension,
      percentile(scores[dimension], reference.distributions[dimension]),
    ]),
  ) as unknown as BehaviorScores;
}
