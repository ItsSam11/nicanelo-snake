import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import type { LoadedTrainingGame } from "./corpus-manifest.js";
import {
  POLICY_FEATURE_NAMES,
  trainingSamplesForGame,
  VALUE_FEATURE_NAMES,
  type PolicySample,
  type ValueSample,
} from "./model-training.js";
import {
  POLICY_CANDIDATE_LIMIT,
  POLICY_RECORD_DOUBLES,
  preparedFileName,
  VALUE_RECORD_DOUBLES,
  type PreparedPartitionCounts,
  type PreparedTrainingFile,
  type PreparedTrainingShard,
  type TrainingPartition,
} from "./prepared-training-format.js";

async function fileMetadata(path: string): Promise<PreparedTrainingFile> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return {
    bytes: (await stat(path)).size,
    digest: `sha256:${hash.digest("hex")}`,
  };
}

function emptyCounts(): PreparedPartitionCounts {
  return { games: 0, policyPrior: 0, opponentPolicy: 0, value: 0 };
}

function encodedPolicySamples(samples: readonly PolicySample[]): Buffer {
  const values = new Float64Array(samples.length * POLICY_RECORD_DOUBLES);
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    if (sample.candidates.length > POLICY_CANDIDATE_LIMIT) {
      throw new Error("Policy sample exceeds the four Battlesnake directions");
    }
    const record = sampleIndex * POLICY_RECORD_DOUBLES;
    values[record] = sample.weight;
    values[record + 1] = sample.candidates.length;
    for (let candidateIndex = 0;
      candidateIndex < sample.candidates.length;
      candidateIndex += 1) {
      const candidate = sample.candidates[candidateIndex]!;
      if (candidate.features.length !== POLICY_FEATURE_NAMES.length) {
        throw new Error("Policy feature count does not match the dataset schema");
      }
      const candidateOffset = record + 2 + candidateIndex * 10;
      for (let featureIndex = 0;
        featureIndex < POLICY_FEATURE_NAMES.length;
        featureIndex += 1) {
        values[candidateOffset + featureIndex] =
          candidate.features[featureIndex] ?? 0;
      }
      values[candidateOffset + POLICY_FEATURE_NAMES.length] =
        sample.targetProbabilities[candidateIndex] ?? 0;
    }
  }
  return Buffer.from(values.buffer);
}

function encodedValueSamples(samples: readonly ValueSample[]): Buffer {
  const values = new Float64Array(samples.length * VALUE_RECORD_DOUBLES);
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    if (sample.features.length !== VALUE_FEATURE_NAMES.length) {
      throw new Error("Value feature count does not match the dataset schema");
    }
    const record = sampleIndex * VALUE_RECORD_DOUBLES;
    for (let featureIndex = 0;
      featureIndex < VALUE_FEATURE_NAMES.length;
      featureIndex += 1) {
      values[record + featureIndex] = sample.features[featureIndex] ?? 0;
    }
    values[record + VALUE_FEATURE_NAMES.length] = sample.phasePriorLogit;
    values[record + VALUE_FEATURE_NAMES.length + 1] = sample.target;
    values[record + VALUE_FEATURE_NAMES.length + 2] = sample.weight;
  }
  return Buffer.from(values.buffer);
}

export class PreparedTrainingShardWriter {
  private readonly streams = new Map<
    string,
    ReturnType<typeof createWriteStream>
  >();
  private readonly counts = {
    training: emptyCounts(),
    validation: emptyCounts(),
  };
  private opened = false;
  private closed = false;

  constructor(
    private readonly outputDirectory: string,
    private readonly shardIndex: number,
  ) {}

  async open(): Promise<void> {
    if (this.opened) throw new Error("Prepared shard writer is already open");
    this.opened = true;
    await mkdir(this.outputDirectory, { recursive: false });
    for (const partition of ["training", "validation"] as const) {
      for (const head of ["policyPrior", "opponentPolicy", "value"] as const) {
        const name = preparedFileName(partition, head);
        this.streams.set(
          name,
          createWriteStream(join(this.outputDirectory, name), { flags: "wx" }),
        );
      }
    }
  }

  async addGame(
    game: Readonly<LoadedTrainingGame>,
    partition: TrainingPartition,
  ): Promise<void> {
    if (!this.opened || this.closed) {
      throw new Error("Prepared shard writer is not open");
    }
    const samples = trainingSamplesForGame(game);
    const partitionCounts = this.counts[partition];
    partitionCounts.games += 1;
    partitionCounts.policyPrior += samples.policyPrior.length;
    partitionCounts.opponentPolicy += samples.opponentPolicy.length;
    partitionCounts.value += samples.value.length;
    await Promise.all([
      this.write(
        preparedFileName(partition, "policyPrior"),
        encodedPolicySamples(samples.policyPrior),
      ),
      this.write(
        preparedFileName(partition, "opponentPolicy"),
        encodedPolicySamples(samples.opponentPolicy),
      ),
      this.write(
        preparedFileName(partition, "value"),
        encodedValueSamples(samples.value),
      ),
    ]);
  }

  async close(): Promise<PreparedTrainingShard> {
    if (!this.opened || this.closed) {
      throw new Error("Prepared shard writer cannot be closed");
    }
    this.closed = true;
    for (const stream of this.streams.values()) stream.end();
    await Promise.all([...this.streams.values()].map((stream) => finished(stream)));
    const files = Object.fromEntries(await Promise.all(
      [...this.streams.keys()].sort().map(async (name) => [
        name,
        await fileMetadata(join(this.outputDirectory, name)),
      ] as const),
    ));
    return {
      index: this.shardIndex,
      directory: basename(this.outputDirectory),
      training: this.counts.training,
      validation: this.counts.validation,
      files,
    };
  }

  abort(error?: Error): void {
    this.closed = true;
    for (const stream of this.streams.values()) stream.destroy(error);
  }

  private async write(name: string, buffer: Buffer): Promise<void> {
    const stream = this.streams.get(name);
    if (stream === undefined) throw new Error(`Prepared stream ${name} is missing`);
    if (!stream.write(buffer)) await once(stream, "drain");
  }
}
