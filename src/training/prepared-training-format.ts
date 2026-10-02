import type { CorpusManifestEntry } from "./corpus-manifest.js";
import type { AzureTrainingSelectionEntry } from "./azure-training-selection.js";

export const PREPARED_TRAINING_SCHEMA_VERSION = 3 as const;
export const POLICY_CANDIDATE_LIMIT = 4;
export const POLICY_RECORD_DOUBLES = 2 + POLICY_CANDIDATE_LIMIT * 10;
// 14 evaluation features + phase-prior logit + target + sample weight.
export const VALUE_RECORD_DOUBLES = 17;

export type TrainingPartition = "training" | "validation";
export type PolicyHead = "policyPrior" | "opponentPolicy";

export interface PreparedSampleCounts {
  policyPrior: number;
  opponentPolicy: number;
  value: number;
}

export interface PreparedPartitionCounts extends PreparedSampleCounts {
  games: number;
}

export interface PreparedTrainingShard {
  index: number;
  directory: string;
  training: PreparedPartitionCounts;
  validation: PreparedPartitionCounts;
  files: Readonly<Record<string, PreparedTrainingFile>>;
}

export interface PreparedTrainingFile {
  bytes: number;
  digest: string;
}

export interface PreparedTrainingSourceShard {
  directory: string;
  files: Readonly<Record<string, PreparedTrainingFile>>;
}

export interface PreparedTrainingDataset {
  schemaVersion: typeof PREPARED_TRAINING_SCHEMA_VERSION;
  featureSetVersion: string;
  policyTargetVersion: string;
  createdAt: string;
  sourceManifest: string;
  corpusDigest: string;
  corpusGames: number;
  validationSplit: "game-hash-v2" | "selection-manifest-v1";
  policyFeatureNames: readonly string[];
  valueFeatureNames: readonly string[];
  binaryFormat: {
    numberType: "float64-le";
    policyRecordDoubles: number;
    valueRecordDoubles: number;
    maximumPolicyCandidates: number;
  };
  storage?: {
    kind: "azure-blob";
    accountUrl: string;
    containerName: string;
  };
  totals: {
    training: PreparedPartitionCounts;
    validation: PreparedPartitionCounts;
  };
  shards: readonly PreparedTrainingShard[];
}

export interface PrepareWorkerData {
  mode: "prepare";
  manifestPath: string;
  entries: readonly CorpusManifestEntry[];
  validationGameIds: readonly string[];
  outputDirectory: string;
  shardIndex: number;
}

export interface AzurePrepareWorkerData {
  mode: "azure-prepare";
  accountUrl: string;
  containerName: string;
  entries: readonly AzureTrainingSelectionEntry[];
  outputDirectory: string;
  shardIndex: number;
}

export interface FilesystemTrainWorkerData {
  mode: "train";
  source: {
    kind: "filesystem";
    shards: readonly PreparedTrainingSourceShard[];
  };
}

export interface AzureBlobTrainWorkerData {
  mode: "train";
  source: {
    kind: "azure-blob";
    accountUrl: string;
    containerName: string;
    shards: readonly PreparedTrainingSourceShard[];
  };
}

export type TrainWorkerData =
  | FilesystemTrainWorkerData
  | AzureBlobTrainWorkerData;

export type PreparedTrainingWorkerData =
  | PrepareWorkerData
  | AzurePrepareWorkerData
  | TrainWorkerData;

export interface PolicyGradientRequest {
  type: "policy-gradient";
  requestId: number;
  head: PolicyHead;
  weights: readonly number[];
  temperature: number;
}

export interface ValueGradientRequest {
  type: "value-gradient";
  requestId: number;
  coefficients: readonly number[];
}

export interface PolicyMetricsRequest {
  type: "policy-metrics";
  requestId: number;
  head: PolicyHead;
  weights: readonly number[];
  temperature: number;
  partition: TrainingPartition;
}

export interface ValueMetricsRequest {
  type: "value-metrics";
  requestId: number;
  coefficients: readonly number[];
  partition: TrainingPartition;
}

export type TrainingWorkerRequest =
  | PolicyGradientRequest
  | ValueGradientRequest
  | PolicyMetricsRequest
  | ValueMetricsRequest;

export type TrainingWorkerRequestInput =
  TrainingWorkerRequest extends infer Request
    ? Request extends { requestId: number }
      ? Omit<Request, "requestId">
      : never
    : never;

export interface GradientResult {
  gradient: readonly number[];
  totalWeight: number;
}

export interface PolicyMetricSums {
  nll: number;
  brier: number;
  correct: number;
  totalWeight: number;
}

export interface ValueMetricSums {
  brier: number;
  totalWeight: number;
}

export interface TrainingWorkerSuccess {
  type: "result";
  requestId: number;
  result: GradientResult | PolicyMetricSums | ValueMetricSums;
}

export interface TrainingWorkerFailure {
  type: "error";
  requestId: number;
  error: string;
}

export type TrainingWorkerResponse =
  | TrainingWorkerSuccess
  | TrainingWorkerFailure;

export function preparedFileName(
  partition: TrainingPartition,
  head: PolicyHead | "value",
): string {
  const normalizedHead = head === "policyPrior"
    ? "policy-prior"
    : head === "opponentPolicy"
    ? "opponent-policy"
    : "value";
  return `${partition}-${normalizedHead}.bin`;
}
