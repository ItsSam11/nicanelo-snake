import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  constrainLearnedEvaluationWeights,
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "../evaluation/weights.js";
import { nonTerminalEvaluationScale } from "../evaluation/value-scale.js";
import {
  parseStrategyModel,
  STRATEGY_MODEL_SCHEMA_VERSION,
  type ModelMetrics,
  type StrategyModelArtifact,
} from "../model/strategy-model.js";
import { STRATEGY_FEATURE_SET_VERSION } from "../model/feature-set.js";
import {
  DEFAULT_OPPONENT_POLICY,
  type OpponentPolicySettings,
} from "../search/opponent-policy.js";
import {
  loadTrainingCorpusEntries,
  type CorpusManifestEntry,
} from "./corpus-manifest.js";
import {
  modelOfflineGate,
  POLICY_FEATURE_NAMES,
  validationBucket,
  VALUE_FEATURE_NAMES,
} from "./model-training.js";
import { PUCT_POLICY_TARGET_VERSION } from "./search-targets.js";
import {
  POLICY_CANDIDATE_LIMIT,
  POLICY_RECORD_DOUBLES,
  PREPARED_TRAINING_SCHEMA_VERSION,
  preparedFileName,
  VALUE_RECORD_DOUBLES,
  type GradientResult,
  type PolicyHead,
  type PolicyMetricSums,
  type PreparedPartitionCounts,
  type PreparedTrainingDataset,
  type PreparedTrainingShard,
  type PreparedTrainingSourceShard,
  type PrepareWorkerData,
  type TrainingPartition,
  type TrainingWorkerRequestInput,
  type TrainingWorkerResponse,
  type TrainWorkerData,
  type ValueMetricSums,
} from "./prepared-training-format.js";

export interface PrepareTrainingDatasetOptions {
  corpusManifest: string;
  outputDirectory: string;
  workers?: number;
  maximumGames?: number;
  createdAt?: string;
}

export interface PreparedModelTrainingOptions {
  datasetManifest: string;
  outputPath: string;
  modelVersion: string;
  workers?: number;
  createdAt?: string;
  epochs?: number;
  policyLearningRate?: number;
  valueLearningRate?: number;
  regularization?: number;
  minimumGames?: number;
  puctConstant?: number;
  progress?: (entry: Readonly<Record<string, unknown>>) => void;
}

export interface PreparedModelTrainingResult {
  model: StrategyModelArtifact;
  workers: number;
  elapsedMs: number;
  rssBytes: number;
}

interface ResolvedTrainingOptions {
  modelVersion: string;
  createdAt: string;
  epochs: number;
  policyLearningRate: number;
  valueLearningRate: number;
  regularization: number;
  minimumGames: number;
  puctConstant: number;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive and finite`);
  }
  return value;
}

function workerCount(
  requested: number | undefined,
  maximum: number,
): number {
  const fallback = Math.max(1, availableParallelism() - 1);
  return Math.min(maximum, positiveInteger(requested ?? fallback, "workers"));
}

function validationGameIds(entries: readonly CorpusManifestEntry[]): Set<string> {
  const natural = entries.filter((entry) => validationBucket(entry.gameId) === 0);
  const selected = natural.length === 0 || natural.length === entries.length
    ? [entries.at(-1)!]
    : natural;
  return new Set(selected.map((entry) => entry.gameId));
}

function corpusDigest(entries: readonly CorpusManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) =>
    a.gameId.localeCompare(b.gameId)
  )) {
    hash.update(JSON.stringify({
      gameId: entry.gameId,
      recordDigest: entry.recordDigest,
      summaryDigest: entry.summaryDigest,
      searchObservationsDigest: entry.searchObservationsDigest ?? null,
      samplingWeight: entry.selection.samplingWeight,
    }));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sumPartitionCounts(
  shards: readonly PreparedTrainingShard[],
  partition: TrainingPartition,
): PreparedPartitionCounts {
  return shards.reduce<PreparedPartitionCounts>((total, shard) => ({
    games: total.games + shard[partition].games,
    policyPrior: total.policyPrior + shard[partition].policyPrior,
    opponentPolicy: total.opponentPolicy + shard[partition].opponentPolicy,
    value: total.value + shard[partition].value,
  }), { games: 0, policyPrior: 0, opponentPolicy: 0, value: 0 });
}

async function prepareWorker(
  data: Readonly<PrepareWorkerData>,
): Promise<PreparedTrainingShard> {
  const worker = new Worker(
    new URL("./prepared-training-worker.js", import.meta.url),
    { workerData: data },
  );
  return await new Promise<PreparedTrainingShard>((resolvePromise, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    worker.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        "type" in message && message.type === "prepared" &&
        "result" in message
      ) {
        const result = message.result as PreparedTrainingShard;
        finish(() => resolvePromise(result));
      }
    });
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`Preparation worker exited with code ${code}`)));
      } else if (!settled) {
        finish(() => reject(new Error("Preparation worker returned no result")));
      }
    });
  });
}

export async function prepareTrainingDataset(
  options: Readonly<PrepareTrainingDatasetOptions>,
): Promise<{ manifestPath: string; dataset: PreparedTrainingDataset }> {
  const allEntries = (await loadTrainingCorpusEntries(options.corpusManifest))
    .sort((a, b) => a.gameId.localeCompare(b.gameId));
  const maximumGames = options.maximumGames === undefined
    ? allEntries.length
    : positiveInteger(options.maximumGames, "maximumGames");
  const entries = allEntries.slice(0, maximumGames);
  if (entries.length < 2) {
    throw new Error("Prepared training requires at least two games");
  }
  const workers = workerCount(options.workers, entries.length);
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory, { recursive: false });
  const validationIds = validationGameIds(entries);
  const partitions = Array.from({ length: workers }, () =>
    [] as CorpusManifestEntry[]
  );
  entries.forEach((entry, index) => partitions[index % workers]!.push(entry));
  const shards = (await Promise.all(partitions.map((partition, index) => {
    const directory = `shard-${index.toString().padStart(3, "0")}`;
    return prepareWorker({
      mode: "prepare",
      manifestPath: resolve(options.corpusManifest),
      entries: partition,
      validationGameIds: [...validationIds],
      outputDirectory: join(options.outputDirectory, directory),
      shardIndex: index,
    });
  }))).sort((a, b) => a.index - b.index);
  const dataset: PreparedTrainingDataset = {
    schemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
    featureSetVersion: STRATEGY_FEATURE_SET_VERSION,
    policyTargetVersion: PUCT_POLICY_TARGET_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    sourceManifest: resolve(options.corpusManifest),
    corpusDigest: corpusDigest(entries),
    corpusGames: entries.length,
    validationSplit: "game-hash-v2",
    policyFeatureNames: POLICY_FEATURE_NAMES,
    valueFeatureNames: VALUE_FEATURE_NAMES,
    binaryFormat: {
      numberType: "float64-le",
      policyRecordDoubles: POLICY_RECORD_DOUBLES,
      valueRecordDoubles: VALUE_RECORD_DOUBLES,
      maximumPolicyCandidates: POLICY_CANDIDATE_LIMIT,
    },
    totals: {
      training: sumPartitionCounts(shards, "training"),
      validation: sumPartitionCounts(shards, "validation"),
    },
    shards,
  };
  const manifestText = `${JSON.stringify(dataset, null, 2)}\n`;
  const manifestPath = join(options.outputDirectory, "manifest.json");
  await writeFile(manifestPath, manifestText, { flag: "wx" });
  await writeFile(
    join(options.outputDirectory, "_SUCCESS.json"),
    `${JSON.stringify({
      schemaVersion: PREPARED_TRAINING_SCHEMA_VERSION,
      featureSetVersion: dataset.featureSetVersion,
      policyTargetVersion: dataset.policyTargetVersion,
      manifestDigest: sha256(manifestText),
      corpusDigest: dataset.corpusDigest,
      corpusGames: dataset.corpusGames,
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  return { manifestPath, dataset };
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function validPreparedCounts(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const counts = value as Record<string, unknown>;
  return ["games", "policyPrior", "opponentPolicy", "value"].every((name) =>
    Number.isSafeInteger(counts[name]) && (counts[name] as number) >= 0
  );
}

function validPreparedShard(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const shard = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(shard.index) || (shard.index as number) < 0 ||
    typeof shard.directory !== "string" || shard.directory.length === 0 ||
    !validPreparedCounts(shard.training) ||
    !validPreparedCounts(shard.validation) ||
    typeof shard.files !== "object" || shard.files === null ||
    Array.isArray(shard.files)
  ) return false;
  const files = shard.files as Record<string, unknown>;
  return (["training", "validation"] as const).every((partition) =>
    (["policyPrior", "opponentPolicy", "value"] as const).every((head) => {
      const file = files[preparedFileName(partition, head)];
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        return false;
      }
      const metadata = file as Record<string, unknown>;
      return Number.isSafeInteger(metadata.bytes) &&
        (metadata.bytes as number) >= 0 &&
        typeof metadata.digest === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(metadata.digest);
    })
  );
}

function preparedDataset(value: unknown): PreparedTrainingDataset {
  const candidate = object(value, "prepared training dataset");
  const storage = candidate.storage;
  const validStorage = storage === undefined || (
    typeof storage === "object" && storage !== null &&
    !Array.isArray(storage) &&
    (storage as Record<string, unknown>).kind === "azure-blob" &&
    typeof (storage as Record<string, unknown>).accountUrl === "string" &&
    typeof (storage as Record<string, unknown>).containerName === "string"
  );
  if (
    candidate.schemaVersion !== PREPARED_TRAINING_SCHEMA_VERSION ||
    candidate.featureSetVersion !== STRATEGY_FEATURE_SET_VERSION ||
    candidate.policyTargetVersion !== PUCT_POLICY_TARGET_VERSION ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.sourceManifest !== "string" ||
    typeof candidate.corpusDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.corpusDigest) ||
    !Number.isSafeInteger(candidate.corpusGames) ||
    (candidate.corpusGames as number) < 2 ||
    candidate.validationSplit !== "game-hash-v2" &&
      candidate.validationSplit !== "selection-manifest-v1" ||
    !sameStrings(candidate.policyFeatureNames, POLICY_FEATURE_NAMES) ||
    !sameStrings(candidate.valueFeatureNames, VALUE_FEATURE_NAMES) ||
    !Array.isArray(candidate.shards) || candidate.shards.length === 0 ||
    !candidate.shards.every((shard) => validPreparedShard(shard)) ||
    !validStorage
  ) {
    throw new Error("Invalid prepared training dataset manifest");
  }
  return candidate as unknown as PreparedTrainingDataset;
}

async function verifyPreparedFileSizes(
  manifestPath: string,
  dataset: Readonly<PreparedTrainingDataset>,
): Promise<void> {
  const base = dirname(manifestPath);
  const container = dataset.storage === undefined
    ? undefined
    : new BlobServiceClient(
      dataset.storage.accountUrl,
      new DefaultAzureCredential(),
    ).getContainerClient(dataset.storage.containerName);
  for (const shard of dataset.shards) {
    const directory = isAbsolute(shard.directory)
      ? shard.directory
      : resolve(base, shard.directory);
    for (const partition of ["training", "validation"] as const) {
      for (const head of ["policyPrior", "opponentPolicy", "value"] as const) {
        const recordDoubles = head === "value"
          ? VALUE_RECORD_DOUBLES
          : POLICY_RECORD_DOUBLES;
        const expectedBytes = shard[partition][head] * recordDoubles * 8;
        const name = preparedFileName(partition, head);
        const declaredBytes = shard.files[name]?.bytes;
        const actualBytes = container === undefined
          ? (await stat(join(directory, name))).size
          : (await container.getBlockBlobClient(
            `${shard.directory}/${name}`,
          ).getProperties()).contentLength;
        if (actualBytes !== expectedBytes || declaredBytes !== expectedBytes) {
          throw new Error(
            `Prepared shard ${shard.index} ${partition} ${head} has ${actualBytes} bytes; expected ${expectedBytes}`,
          );
        }
      }
    }
  }
}

export async function loadPreparedTrainingDataset(
  manifestPath: string,
): Promise<PreparedTrainingDataset> {
  const manifestText = await readFile(manifestPath, "utf8");
  const dataset = preparedDataset(JSON.parse(manifestText) as unknown);
  const success = object(
    JSON.parse(
      await readFile(join(dirname(manifestPath), "_SUCCESS.json"), "utf8"),
    ) as unknown,
    "prepared dataset success marker",
  );
  if (
    success.manifestDigest !== sha256(manifestText) ||
    success.featureSetVersion !== dataset.featureSetVersion ||
    success.policyTargetVersion !== dataset.policyTargetVersion ||
    success.corpusDigest !== dataset.corpusDigest ||
    success.corpusGames !== dataset.corpusGames
  ) {
    throw new Error("Prepared dataset success marker does not match its manifest");
  }
  await verifyPreparedFileSizes(manifestPath, dataset);
  return dataset;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class TrainingWorkerSlot {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  readonly ready: Promise<void>;

  constructor(source: TrainWorkerData["source"]) {
    this.worker = new Worker(
      new URL("./prepared-training-worker.js", import.meta.url),
      { workerData: { mode: "train", source } as TrainWorkerData },
    );
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      let ready = false;
      this.worker.on("message", (message: unknown) => {
        if (
          typeof message === "object" && message !== null &&
          "type" in message && message.type === "ready"
        ) {
          ready = true;
          resolveReady();
          return;
        }
        const response = message as TrainingWorkerResponse;
        const pending = this.pending.get(response.requestId);
        if (pending === undefined) return;
        this.pending.delete(response.requestId);
        if (response.type === "result") pending.resolve(response.result);
        else pending.reject(new Error(response.error));
      });
      this.worker.on("error", (error) => {
        if (!ready) rejectReady(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
      this.worker.on("exit", (code) => {
        if (!ready && code !== 0) {
          rejectReady(new Error(`Training worker exited with code ${code}`));
        }
        if (code !== 0) {
          const error = new Error(`Training worker exited with code ${code}`);
          for (const pending of this.pending.values()) pending.reject(error);
          this.pending.clear();
        }
      });
    });
  }

  async request(
    request: TrainingWorkerRequestInput,
  ): Promise<unknown> {
    await this.ready;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return await new Promise<unknown>((resolveRequest, reject) => {
      this.pending.set(requestId, { resolve: resolveRequest, reject });
      this.worker.postMessage({ ...request, requestId });
    });
  }

  async close(): Promise<void> {
    const error = new Error("Training worker pool closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    await this.worker.terminate();
  }
}

class PreparedTrainingPool {
  private readonly workers: TrainingWorkerSlot[];

  constructor(
    manifestPath: string,
    dataset: Readonly<PreparedTrainingDataset>,
    count: number,
  ) {
    const assignments = Array.from(
      { length: count },
      () => [] as PreparedTrainingSourceShard[],
    );
    const base = dirname(manifestPath);
    dataset.shards.forEach((shard, index) => {
      const location = dataset.storage === undefined
        ? isAbsolute(shard.directory)
          ? shard.directory
          : resolve(base, shard.directory)
        : shard.directory;
      assignments[index % count]!.push({
        directory: location,
        files: shard.files,
      });
    });
    this.workers = assignments.map((shards) => {
      const source: TrainWorkerData["source"] = dataset.storage === undefined
        ? { kind: "filesystem", shards }
        : {
          kind: "azure-blob",
          accountUrl: dataset.storage.accountUrl,
          containerName: dataset.storage.containerName,
          shards,
        };
      return new TrainingWorkerSlot(source);
    });
  }

  async start(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.ready));
  }

  async request<T>(
    request: TrainingWorkerRequestInput,
  ): Promise<T[]> {
    return await Promise.all(
      this.workers.map((worker) => worker.request(request) as Promise<T>),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}

function resolvedTrainingOptions(
  options: Readonly<PreparedModelTrainingOptions>,
): ResolvedTrainingOptions {
  if (options.modelVersion.trim().length === 0) {
    throw new Error("modelVersion must be non-empty");
  }
  const epochs = positiveInteger(options.epochs ?? 200, "epochs");
  const minimumGames = positiveInteger(options.minimumGames ?? 20, "minimumGames");
  if (minimumGames < 2) throw new Error("minimumGames must be at least two");
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("createdAt must be an ISO timestamp");
  }
  const regularization = options.regularization ?? 0.02;
  if (!Number.isFinite(regularization) || regularization < 0) {
    throw new Error("regularization must be finite and non-negative");
  }
  return {
    modelVersion: options.modelVersion,
    createdAt,
    epochs,
    minimumGames,
    regularization,
    policyLearningRate: finitePositive(
      options.policyLearningRate ?? 0.12,
      "policyLearningRate",
    ),
    valueLearningRate: finitePositive(
      options.valueLearningRate ?? 0.08,
      "valueLearningRate",
    ),
    puctConstant: finitePositive(options.puctConstant ?? 1.25, "puctConstant"),
  };
}

function policyVector(settings: Readonly<OpponentPolicySettings>): number[] {
  return POLICY_FEATURE_NAMES.map((name) => settings.weights[name]);
}

function policySettings(
  weights: readonly number[],
  temperature: number,
): OpponentPolicySettings {
  return {
    temperature,
    weights: Object.fromEntries(
      POLICY_FEATURE_NAMES.map((name, index) => [name, weights[index] ?? 0]),
    ) as unknown as OpponentPolicySettings["weights"],
  };
}

function nonTerminalScale(weights: Readonly<EvaluationWeights>): number {
  return nonTerminalEvaluationScale(weights);
}

function valueVector(
  weights: Readonly<EvaluationWeights>,
  valueBias = 0,
): number[] {
  const scale = Math.max(1, nonTerminalScale(weights));
  return VALUE_FEATURE_NAMES.map((name) =>
    name === "survival" ? valueBias : 4 * weights[name] / scale
  );
}

function learnedValueWeights(coefficients: readonly number[]): EvaluationWeights {
  const scale = Math.max(1, nonTerminalScale(DEFAULT_EVALUATION_WEIGHTS));
  const learned = Object.fromEntries(
    VALUE_FEATURE_NAMES.map((name, index) => [
      name,
      name === "survival"
        ? DEFAULT_EVALUATION_WEIGHTS.survival
        : (coefficients[index] ?? 0) * scale / 4,
    ]),
  ) as unknown as Pick<EvaluationWeights, typeof VALUE_FEATURE_NAMES[number]>;
  return constrainLearnedEvaluationWeights({
    ...DEFAULT_EVALUATION_WEIGHTS,
    ...learned,
  });
}

function aggregateGradients(
  results: readonly GradientResult[],
  length: number,
): GradientResult {
  const gradient = Array.from({ length }, () => 0);
  let totalWeight = 0;
  for (const result of results) {
    for (let index = 0; index < length; index += 1) {
      gradient[index] = (gradient[index] ?? 0) +
        (result.gradient[index] ?? 0);
    }
    totalWeight += result.totalWeight;
  }
  return { gradient, totalWeight };
}

async function trainPolicy(
  pool: PreparedTrainingPool,
  head: PolicyHead,
  sampleCount: number,
  options: Readonly<ResolvedTrainingOptions>,
  progress: (entry: Readonly<Record<string, unknown>>) => void,
): Promise<OpponentPolicySettings> {
  if (sampleCount === 0) return DEFAULT_OPPONENT_POLICY;
  const anchor = policyVector(DEFAULT_OPPONENT_POLICY);
  const weights = [...anchor];
  const interval = Math.max(1, Math.floor(options.epochs / 10));
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const result = aggregateGradients(
      await pool.request<GradientResult>({
        type: "policy-gradient",
        head,
        weights,
        temperature: DEFAULT_OPPONENT_POLICY.temperature,
      }),
      weights.length,
    );
    for (let index = 0; index < weights.length; index += 1) {
      const dataGradient = (result.gradient[index] ?? 0) /
        Math.max(1, result.totalWeight);
      const anchorGradient = options.regularization *
        ((weights[index] ?? 0) - (anchor[index] ?? 0));
      weights[index] = Math.max(
        -20,
        Math.min(
          20,
          (weights[index] ?? 0) - options.policyLearningRate *
            (dataGradient + anchorGradient),
        ),
      );
    }
    if ((epoch + 1) % interval === 0 || epoch + 1 === options.epochs) {
      progress({
        event: "training_epoch_progress",
        head,
        epoch: epoch + 1,
        epochs: options.epochs,
      });
    }
  }
  return policySettings(weights, DEFAULT_OPPONENT_POLICY.temperature);
}

async function trainValue(
  pool: PreparedTrainingPool,
  options: Readonly<ResolvedTrainingOptions>,
  progress: (entry: Readonly<Record<string, unknown>>) => void,
): Promise<{ evaluationWeights: EvaluationWeights; valueBias: number }> {
  const anchor = valueVector(DEFAULT_EVALUATION_WEIGHTS);
  const coefficients = [...anchor];
  const interval = Math.max(1, Math.floor(options.epochs / 10));
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const result = aggregateGradients(
      await pool.request<GradientResult>({
        type: "value-gradient",
        coefficients,
      }),
      coefficients.length,
    );
    for (let index = 0; index < coefficients.length; index += 1) {
      const dataGradient = (result.gradient[index] ?? 0) /
        Math.max(1, result.totalWeight);
      const anchorGradient = options.regularization *
        ((coefficients[index] ?? 0) - (anchor[index] ?? 0));
      coefficients[index] = Math.max(
        -6,
        Math.min(
          6,
          (coefficients[index] ?? 0) - options.valueLearningRate *
            (dataGradient + anchorGradient),
        ),
      );
    }
    if ((epoch + 1) % interval === 0 || epoch + 1 === options.epochs) {
      progress({
        event: "training_epoch_progress",
        head: "value",
        epoch: epoch + 1,
        epochs: options.epochs,
      });
    }
  }
  return {
    evaluationWeights: learnedValueWeights(coefficients),
    valueBias: coefficients[VALUE_FEATURE_NAMES.indexOf("survival")] ?? 0,
  };
}

function aggregatePolicyMetrics(
  results: readonly PolicyMetricSums[],
): PolicyMetricSums {
  return results.reduce<PolicyMetricSums>((total, result) => ({
    nll: total.nll + result.nll,
    brier: total.brier + result.brier,
    correct: total.correct + result.correct,
    totalWeight: total.totalWeight + result.totalWeight,
  }), { nll: 0, brier: 0, correct: 0, totalWeight: 0 });
}

async function policyMetrics(
  pool: PreparedTrainingPool,
  head: PolicyHead,
  policy: Readonly<OpponentPolicySettings>,
): Promise<ReturnType<typeof aggregatePolicyMetrics>> {
  return aggregatePolicyMetrics(await pool.request<PolicyMetricSums>({
    type: "policy-metrics",
    partition: "validation",
    head,
    weights: policyVector(policy),
    temperature: policy.temperature,
  }));
}

async function modelMetrics(
  pool: PreparedTrainingPool,
  policyPrior: Readonly<OpponentPolicySettings>,
  opponentPolicy: Readonly<OpponentPolicySettings>,
  evaluationWeights: Readonly<EvaluationWeights>,
  valueBias = 0,
  phasePriorOnly = false,
): Promise<ModelMetrics> {
  const [prior, opponent, valueParts] = await Promise.all([
    policyMetrics(pool, "policyPrior", policyPrior),
    policyMetrics(pool, "opponentPolicy", opponentPolicy),
    pool.request<ValueMetricSums>({
      type: "value-metrics",
      partition: "validation",
      coefficients: phasePriorOnly
        ? VALUE_FEATURE_NAMES.map(() => 0)
        : valueVector(evaluationWeights, valueBias),
    }),
  ]);
  const value = valueParts.reduce<ValueMetricSums>((total, part) => ({
    brier: total.brier + part.brier,
    totalWeight: total.totalWeight + part.totalWeight,
  }), { brier: 0, totalWeight: 0 });
  return {
    policyNll: prior.nll / Math.max(1, prior.totalWeight),
    policyAccuracy: prior.correct / Math.max(1, prior.totalWeight),
    opponentPolicyNll: opponent.nll / Math.max(1, opponent.totalWeight),
    opponentPolicyAccuracy:
      opponent.correct / Math.max(1, opponent.totalWeight),
    opponentPolicyBrier:
      opponent.brier / Math.max(1, opponent.totalWeight),
    valueBrier: value.brier / Math.max(1, value.totalWeight),
  };
}

export async function trainPreparedStrategyModel(
  options: Readonly<PreparedModelTrainingOptions>,
): Promise<PreparedModelTrainingResult> {
  const startedAt = performance.now();
  const resolved = resolvedTrainingOptions(options);
  const dataset = await loadPreparedTrainingDataset(options.datasetManifest);
  if (dataset.corpusGames < resolved.minimumGames) {
    throw new Error(
      `Need at least ${resolved.minimumGames} complete games; received ${dataset.corpusGames}`,
    );
  }
  if (
    dataset.totals.training.opponentPolicy === 0 ||
    dataset.totals.training.value === 0 ||
    dataset.totals.validation.opponentPolicy === 0 ||
    dataset.totals.validation.value === 0
  ) {
    throw new Error(
      "Prepared corpus does not contain enough separate opponent and value samples",
    );
  }
  const workers = workerCount(options.workers, dataset.shards.length);
  const pool = new PreparedTrainingPool(
    resolve(options.datasetManifest),
    dataset,
    workers,
  );
  const progress = options.progress ?? (() => undefined);
  try {
    await pool.start();
    progress({ event: "training_workers_ready", workers });
    const opponentPolicy = await trainPolicy(
      pool,
      "opponentPolicy",
      dataset.totals.training.opponentPolicy,
      resolved,
      progress,
    );
    progress({ event: "training_head_complete", head: "opponentPolicy" });
    const policyPrior = await trainPolicy(
      pool,
      "policyPrior",
      dataset.totals.training.policyPrior,
      resolved,
      progress,
    );
    progress({ event: "training_head_complete", head: "policyPrior" });
    const trainedValue = await trainValue(pool, resolved, progress);
    const { evaluationWeights, valueBias } = trainedValue;
    progress({ event: "training_head_complete", head: "value" });
    const [baselineValidation, candidateValidation] = await Promise.all([
      modelMetrics(
        pool,
        DEFAULT_OPPONENT_POLICY,
        DEFAULT_OPPONENT_POLICY,
        DEFAULT_EVALUATION_WEIGHTS,
        0,
        true,
      ),
      modelMetrics(
        pool,
        policyPrior,
        opponentPolicy,
        evaluationWeights,
        valueBias,
      ),
    ]);
    const model = parseStrategyModel({
      schemaVersion: STRATEGY_MODEL_SCHEMA_VERSION,
      modelVersion: resolved.modelVersion,
      createdAt: resolved.createdAt,
      evaluationWeights,
      policyPrior,
      opponentPolicy,
      search: { puctConstant: resolved.puctConstant, valueBias },
      training: {
        method: "softmax-gradient",
        featureSetVersion: dataset.featureSetVersion,
        corpusDigest: dataset.corpusDigest,
        corpusGames: dataset.corpusGames,
        trainingSamples:
          dataset.totals.training.policyPrior +
          dataset.totals.training.opponentPolicy +
          dataset.totals.training.value,
        validationSamples:
          dataset.totals.validation.policyPrior +
          dataset.totals.validation.opponentPolicy +
          dataset.totals.validation.value,
        policyPriorTrainingSamples: dataset.totals.training.policyPrior,
        opponentPolicyTrainingSamples: dataset.totals.training.opponentPolicy,
        valueTrainingSamples: dataset.totals.training.value,
        policyPriorValidationSamples: dataset.totals.validation.policyPrior,
        opponentPolicyValidationSamples:
          dataset.totals.validation.opponentPolicy,
        valueValidationSamples: dataset.totals.validation.value,
        epochs: resolved.epochs,
        validationSplit: dataset.validationSplit,
        baselineValidation,
        candidateValidation,
        offlineGatePassed: modelOfflineGate(
          baselineValidation,
          candidateValidation,
          evaluationWeights,
        ),
      },
    });
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(
      options.outputPath,
      `${JSON.stringify(model, null, 2)}\n`,
      { flag: "wx" },
    );
    return {
      model,
      workers,
      elapsedMs: performance.now() - startedAt,
      rssBytes: process.memoryUsage().rss,
    };
  } finally {
    await pool.close();
  }
}
