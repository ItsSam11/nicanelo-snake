import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
  loadTrainingGameFromManifestEntry,
  type LoadedTrainingGame,
} from "./corpus-manifest.js";
import {
  parseOfficialReplayJsonl,
  parseReplaySummary,
  validateChampionshipReplay,
} from "./replay-corpus.js";
import {
  parsePuctPolicyTargetsJsonl,
  validatePuctPolicyTargetsForReplay,
} from "./search-targets.js";
import { POLICY_FEATURE_NAMES, VALUE_FEATURE_NAMES } from "./model-training.js";
import {
  POLICY_RECORD_DOUBLES,
  preparedFileName,
  VALUE_RECORD_DOUBLES,
  type GradientResult,
  type AzurePrepareWorkerData,
  type PolicyGradientRequest,
  type PolicyHead,
  type PolicyMetricSums,
  type PolicyMetricsRequest,
  type PreparedTrainingWorkerData,
  type PreparedTrainingFile,
  type PreparedTrainingSourceShard,
  type PrepareWorkerData,
  type TrainingPartition,
  type TrainingWorkerRequest,
  type ValueGradientRequest,
  type ValueMetricSums,
  type ValueMetricsRequest,
} from "./prepared-training-format.js";
import { PreparedTrainingShardWriter } from "./prepared-training-shard.js";

if (parentPort === null) {
  throw new Error("Prepared training worker requires a parent port");
}

const port = parentPort;

async function prepareShard(data: Readonly<PrepareWorkerData>): Promise<void> {
  const writer = new PreparedTrainingShardWriter(
    data.outputDirectory,
    data.shardIndex,
  );
  await writer.open();
  const validationIds = new Set(data.validationGameIds);
  const verifiedReferences = new Set<string>();
  try {
    for (const entry of data.entries) {
      const game = await loadTrainingGameFromManifestEntry(
        data.manifestPath,
        entry,
        verifiedReferences,
      );
      const partition: TrainingPartition = validationIds.has(entry.gameId)
        ? "validation"
        : "training";
      await writer.addGame(game, partition);
    }
    const result = await writer.close();
    port.postMessage({ type: "prepared", result });
  } catch (error) {
    writer.abort(error instanceof Error ? error : undefined);
    throw error;
  }
}

async function azureTrainingGame(
  container: ContainerClient,
  entry: Readonly<AzurePrepareWorkerData["entries"][number]>,
): Promise<LoadedTrainingGame> {
  const [recordBuffer, summaryBuffer, searchBuffer] = await Promise.all([
    container.getBlockBlobClient(entry.record.name).downloadToBuffer(
      0,
      undefined,
      { conditions: { ifMatch: entry.record.etag } },
    ),
    container.getBlockBlobClient(entry.summary.name).downloadToBuffer(
      0,
      undefined,
      { conditions: { ifMatch: entry.summary.etag } },
    ),
    container.getBlockBlobClient(entry.searchObservations.name).downloadToBuffer(
      0,
      undefined,
      { conditions: { ifMatch: entry.searchObservations.etag } },
    ),
  ]);
  const replay = parseOfficialReplayJsonl(recordBuffer.toString("utf8"));
  const summary = parseReplaySummary(summaryBuffer.toString("utf8"));
  const searchTargets = parsePuctPolicyTargetsJsonl(searchBuffer.toString("utf8"));
  validateChampionshipReplay(replay);
  validatePuctPolicyTargetsForReplay(searchTargets, replay);
  if (replay.metadata.id !== entry.gameId || summary.gameId !== entry.gameId) {
    throw new Error(`Azure selection identity mismatch for ${entry.gameId}`);
  }
  return {
    replay,
    summary,
    samplingWeight: entry.samplingWeight,
    searchTargets,
  };
}

async function prepareAzureShard(
  data: Readonly<AzurePrepareWorkerData>,
): Promise<void> {
  const container = new BlobServiceClient(
    data.accountUrl,
    new DefaultAzureCredential(),
  ).getContainerClient(data.containerName);
  const writer = new PreparedTrainingShardWriter(
    data.outputDirectory,
    data.shardIndex,
  );
  await writer.open();
  try {
    for (const entry of data.entries) {
      const game = await azureTrainingGame(container, entry);
      await writer.addGame(
        game,
        entry.roles.includes("validation") ? "validation" : "training",
      );
    }
    const result = await writer.close();
    port.postMessage({ type: "prepared", result });
  } catch (error) {
    writer.abort(error instanceof Error ? error : undefined);
    throw error;
  }
}

function float64View(buffer: Buffer): Float64Array {
  if (buffer.byteLength % 8 !== 0) {
    throw new Error("Prepared dataset file is not aligned to Float64 records");
  }
  if (buffer.byteOffset % 8 === 0) {
    return new Float64Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 8,
    );
  }
  const copied = Uint8Array.from(buffer);
  return new Float64Array(copied.buffer);
}

interface LoadedShard {
  training: {
    policyPrior: Float64Array;
    opponentPolicy: Float64Array;
    value: Float64Array;
  };
  validation: {
    policyPrior: Float64Array;
    opponentPolicy: Float64Array;
    value: Float64Array;
  };
}

async function loadShard(
  shard: Readonly<PreparedTrainingSourceShard>,
  container?: ContainerClient,
): Promise<LoadedShard> {
  async function load(
    partition: TrainingPartition,
    head: PolicyHead | "value",
    recordDoubles: number,
  ): Promise<Float64Array> {
    const name = preparedFileName(partition, head);
    const buffer = container === undefined
      ? await readFile(join(shard.directory, name))
      : await container.getBlockBlobClient(
        `${shard.directory}/${name}`,
      ).downloadToBuffer();
    verifyPreparedBuffer(name, buffer, shard.files[name]);
    const values = float64View(buffer);
    if (values.length % recordDoubles !== 0) {
      throw new Error(`Prepared file ${preparedFileName(partition, head)} is truncated`);
    }
    return values;
  }
  const [
    trainingPolicyPrior,
    trainingOpponentPolicy,
    trainingValue,
    validationPolicyPrior,
    validationOpponentPolicy,
    validationValue,
  ] = await Promise.all([
    load("training", "policyPrior", POLICY_RECORD_DOUBLES),
    load("training", "opponentPolicy", POLICY_RECORD_DOUBLES),
    load("training", "value", VALUE_RECORD_DOUBLES),
    load("validation", "policyPrior", POLICY_RECORD_DOUBLES),
    load("validation", "opponentPolicy", POLICY_RECORD_DOUBLES),
    load("validation", "value", VALUE_RECORD_DOUBLES),
  ]);
  return {
    training: {
      policyPrior: trainingPolicyPrior,
      opponentPolicy: trainingOpponentPolicy,
      value: trainingValue,
    },
    validation: {
      policyPrior: validationPolicyPrior,
      opponentPolicy: validationOpponentPolicy,
      value: validationValue,
    },
  };
}

function verifyPreparedBuffer(
  name: string,
  buffer: Buffer,
  expected: PreparedTrainingFile | undefined,
): void {
  if (expected === undefined) {
    throw new Error(`Prepared shard is missing metadata for ${name}`);
  }
  const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  if (buffer.byteLength !== expected.bytes || digest !== expected.digest) {
    throw new Error(`Prepared file ${name} failed its integrity check`);
  }
}

function softmaxForRecord(
  values: Float64Array,
  record: number,
  candidateCount: number,
  weights: readonly number[],
  temperature: number,
): number[] {
  const scores: number[] = [];
  for (let candidateIndex = 0;
    candidateIndex < candidateCount;
    candidateIndex += 1) {
    const candidate = record + 2 + candidateIndex * 10;
    let score = 0;
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      score += (values[candidate + featureIndex] ?? 0) *
        (weights[featureIndex] ?? 0);
    }
    scores.push(score / temperature);
  }
  const maximum = Math.max(...scores);
  const exponentials = scores.map((score) => Math.exp(score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function policyGradient(
  arrays: readonly Float64Array[],
  request: Readonly<PolicyGradientRequest>,
): GradientResult {
  const gradient = request.weights.map(() => 0);
  let totalWeight = 0;
  for (const values of arrays) {
    for (let record = 0;
      record < values.length;
      record += POLICY_RECORD_DOUBLES) {
      const sampleWeight = values[record] ?? 0;
      const candidateCount = values[record + 1] ?? 0;
      const probabilities = softmaxForRecord(
        values,
        record,
        candidateCount,
        request.weights,
        request.temperature,
      );
      for (let candidateIndex = 0;
        candidateIndex < candidateCount;
        candidateIndex += 1) {
        const candidate = record + 2 + candidateIndex * 10;
        const target = values[candidate + POLICY_FEATURE_NAMES.length] ?? 0;
        const error = (probabilities[candidateIndex] ?? 0) - target;
        for (let featureIndex = 0;
          featureIndex < gradient.length;
          featureIndex += 1) {
          gradient[featureIndex] = (gradient[featureIndex] ?? 0) +
            sampleWeight * error * (values[candidate + featureIndex] ?? 0) /
              request.temperature;
        }
      }
      totalWeight += sampleWeight;
    }
  }
  return { gradient, totalWeight };
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-value);
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function valuePrediction(
  values: Float64Array,
  record: number,
  coefficients: readonly number[],
): number {
  let score = values[record + VALUE_FEATURE_NAMES.length] ?? 0;
  for (let index = 0; index < coefficients.length; index += 1) {
    score += (values[record + index] ?? 0) * (coefficients[index] ?? 0);
  }
  return sigmoid(score);
}

function valueGradient(
  arrays: readonly Float64Array[],
  request: Readonly<ValueGradientRequest>,
): GradientResult {
  const gradient = request.coefficients.map(() => 0);
  let totalWeight = 0;
  for (const values of arrays) {
    for (let record = 0;
      record < values.length;
      record += VALUE_RECORD_DOUBLES) {
      const target = values[record + VALUE_FEATURE_NAMES.length + 1] ?? 0;
      const weight = values[record + VALUE_FEATURE_NAMES.length + 2] ?? 0;
      const error = valuePrediction(values, record, request.coefficients) - target;
      for (let index = 0; index < gradient.length; index += 1) {
        gradient[index] = (gradient[index] ?? 0) +
          weight * error * (values[record + index] ?? 0);
      }
      totalWeight += weight;
    }
  }
  return { gradient, totalWeight };
}

function policyMetrics(
  arrays: readonly Float64Array[],
  request: Readonly<PolicyMetricsRequest>,
): PolicyMetricSums {
  let nll = 0;
  let brier = 0;
  let correct = 0;
  let totalWeight = 0;
  for (const values of arrays) {
    for (let record = 0;
      record < values.length;
      record += POLICY_RECORD_DOUBLES) {
      const weight = values[record] ?? 0;
      const candidateCount = values[record + 1] ?? 0;
      const probabilities = softmaxForRecord(
        values,
        record,
        candidateCount,
        request.weights,
        request.temperature,
      );
      let predicted = 0;
      let targetIndex = 0;
      for (let candidateIndex = 0;
        candidateIndex < candidateCount;
        candidateIndex += 1) {
        const candidate = record + 2 + candidateIndex * 10;
        const target = values[candidate + POLICY_FEATURE_NAMES.length] ?? 0;
        const probability = probabilities[candidateIndex] ?? 0;
        nll -= weight * target * Math.log(Math.max(1e-12, probability));
        const error = probability - target;
        brier += weight * error * error;
        if (probability > (probabilities[predicted] ?? -1)) {
          predicted = candidateIndex;
        }
        const targetCandidate = record + 2 + targetIndex * 10;
        if (target >
          (values[targetCandidate + POLICY_FEATURE_NAMES.length] ?? -1)) {
          targetIndex = candidateIndex;
        }
      }
      correct += weight * Number(predicted === targetIndex);
      totalWeight += weight;
    }
  }
  return { nll, brier, correct, totalWeight };
}

function valueMetrics(
  arrays: readonly Float64Array[],
  request: Readonly<ValueMetricsRequest>,
): ValueMetricSums {
  let brier = 0;
  let totalWeight = 0;
  for (const values of arrays) {
    for (let record = 0;
      record < values.length;
      record += VALUE_RECORD_DOUBLES) {
      const target = values[record + VALUE_FEATURE_NAMES.length + 1] ?? 0;
      const weight = values[record + VALUE_FEATURE_NAMES.length + 2] ?? 0;
      const error = valuePrediction(values, record, request.coefficients) - target;
      brier += weight * error * error;
      totalWeight += weight;
    }
  }
  return { brier, totalWeight };
}

async function trainWorker(
  data: Extract<PreparedTrainingWorkerData, { mode: "train" }>,
): Promise<void> {
  const source = data.source;
  const shards = source.kind === "filesystem"
    ? await Promise.all(
      source.shards.map((shard) => loadShard(shard)),
    )
    : await Promise.all((() => {
      const container = new BlobServiceClient(
        source.accountUrl,
        new DefaultAzureCredential(),
      ).getContainerClient(source.containerName);
      return source.shards.map((shard) => loadShard(shard, container));
    })());
  port.postMessage({ type: "ready" });
  port.on("message", (request: TrainingWorkerRequest) => {
    try {
      let result: GradientResult | PolicyMetricSums | ValueMetricSums;
      if (request.type === "policy-gradient") {
        result = policyGradient(
          shards.map((shard) => shard.training[request.head]),
          request,
        );
      } else if (request.type === "value-gradient") {
        result = valueGradient(
          shards.map((shard) => shard.training.value),
          request,
        );
      } else if (request.type === "policy-metrics") {
        result = policyMetrics(
          shards.map((shard) => shard[request.partition][request.head]),
          request,
        );
      } else {
        result = valueMetrics(
          shards.map((shard) => shard[request.partition].value),
          request,
        );
      }
      port.postMessage({ type: "result", requestId: request.requestId, result });
    } catch (error) {
      port.postMessage({
        type: "error",
        requestId: request.requestId,
        error: error instanceof Error ? error.message : "Training worker failed",
      });
    }
  });
}

const data = workerData as PreparedTrainingWorkerData;
if (data.mode === "prepare") {
  void prepareShard(data).catch((error: unknown) => {
    throw error;
  });
} else if (data.mode === "azure-prepare") {
  void prepareAzureShard(data).catch((error: unknown) => {
    throw error;
  });
} else {
  void trainWorker(data).catch((error: unknown) => {
    throw error;
  });
}
