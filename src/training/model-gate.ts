import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadStrategyModel } from "../model/strategy-model.js";

interface ManifestLatency {
  snakeName: string;
  p95Ms: number;
}

interface ManifestElimination {
  snakeName: string;
}

interface ManifestSummary {
  winnerName: string;
  isDraw: boolean;
  eliminations: readonly ManifestElimination[];
  latency: readonly ManifestLatency[];
}

interface SuccessfulManifestEntry {
  success: true;
  summary: ManifestSummary;
}

export interface TournamentGateOptions {
  candidateNames: readonly string[];
  minimumGames: number;
  minimumWinRate: number;
  maximumP95LatencyMs: number;
}

export interface TournamentGateResult {
  passed: boolean;
  games: number;
  wins: number;
  winRate: number;
  maximumObservedP95Ms: number;
  reasons: readonly string[];
}

export interface ModelGateCliOptions extends TournamentGateOptions {
  modelPath: string;
  manifestPath: string;
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function parseManifestEntry(value: unknown): SuccessfulManifestEntry | undefined {
  const entry = record(value, "manifest entry");
  if (entry.success !== true) return undefined;
  const summary = record(entry.summary, "manifest summary");
  if (
    typeof summary.winnerName !== "string" ||
    typeof summary.isDraw !== "boolean" ||
    !Array.isArray(summary.eliminations) ||
    !Array.isArray(summary.latency)
  ) {
    throw new Error("Manifest summary is missing tournament fields");
  }
  return {
    success: true,
    summary: {
      winnerName: summary.winnerName,
      isDraw: summary.isDraw,
      eliminations: summary.eliminations.map((item) => {
        const elimination = record(item, "manifest elimination");
        if (typeof elimination.snakeName !== "string") {
          throw new Error("Manifest elimination is missing snakeName");
        }
        return { snakeName: elimination.snakeName };
      }),
      latency: summary.latency.map((item) => {
        const latency = record(item, "manifest latency");
        if (
          typeof latency.snakeName !== "string" ||
          typeof latency.p95Ms !== "number" ||
          !Number.isFinite(latency.p95Ms)
        ) {
          throw new Error("Manifest latency is invalid");
        }
        return { snakeName: latency.snakeName, p95Ms: latency.p95Ms };
      }),
    },
  };
}

export function parseManifestJsonl(text: string): SuccessfulManifestEntry[] {
  return text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return parseManifestEntry(JSON.parse(line) as unknown);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid JSON";
        throw new Error(`Manifest line ${index + 1}: ${detail}`);
      }
    })
    .filter((entry): entry is SuccessfulManifestEntry => entry !== undefined);
}

export function evaluateTournamentGate(
  entries: readonly SuccessfulManifestEntry[],
  options: Readonly<TournamentGateOptions>,
): TournamentGateResult {
  const names = new Set(options.candidateNames);
  const relevant = entries.filter((entry) =>
    entry.summary.eliminations.some((item) => names.has(item.snakeName))
  );
  const wins = relevant.filter((entry) =>
    !entry.summary.isDraw && names.has(entry.summary.winnerName)
  ).length;
  const winRate = wins / Math.max(1, relevant.length);
  const latencies = relevant.flatMap((entry) =>
    entry.summary.latency
      .filter((item) => names.has(item.snakeName))
      .map((item) => item.p95Ms)
  );
  const maximumObservedP95Ms = Math.max(0, ...latencies);
  const reasons: string[] = [];
  if (relevant.length < options.minimumGames) {
    reasons.push(
      `need ${options.minimumGames} candidate games; found ${relevant.length}`,
    );
  }
  if (winRate < options.minimumWinRate) {
    reasons.push(
      `win rate ${winRate.toFixed(3)} is below ${options.minimumWinRate.toFixed(3)}`,
    );
  }
  if (latencies.length === 0) {
    reasons.push("no candidate latency samples found");
  } else if (maximumObservedP95Ms > options.maximumP95LatencyMs) {
    reasons.push(
      `p95 latency ${maximumObservedP95Ms} ms exceeds ${options.maximumP95LatencyMs} ms`,
    );
  }
  return {
    passed: reasons.length === 0,
    games: relevant.length,
    wins,
    winRate,
    maximumObservedP95Ms,
    reasons,
  };
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function fraction(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between zero and one`);
  }
  return parsed;
}

export function parseModelGateOptions(argv: readonly string[]): ModelGateCliOptions {
  const candidateNames: string[] = [];
  const values: Partial<ModelGateCliOptions> = {
    minimumGames: 20,
    minimumWinRate: 0.25,
    maximumP95LatencyMs: 250,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}`);
    switch (flag) {
      case "--model":
        values.modelPath = value;
        break;
      case "--manifest":
        values.manifestPath = value;
        break;
      case "--candidate-name":
        candidateNames.push(value);
        break;
      case "--min-games":
        values.minimumGames = positiveInteger(value, flag);
        break;
      case "--min-win-rate":
        values.minimumWinRate = fraction(value, flag);
        break;
      case "--max-p95-ms":
        values.maximumP95LatencyMs = positiveInteger(value, flag);
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
    index += 1;
  }
  if (values.modelPath === undefined) throw new Error("--model is required");
  if (values.manifestPath === undefined) throw new Error("--manifest is required");
  if (candidateNames.length === 0) throw new Error("--candidate-name is required");
  return { ...values, candidateNames } as ModelGateCliOptions;
}

export async function runModelGate(
  options: Readonly<ModelGateCliOptions>,
): Promise<TournamentGateResult> {
  const model = await loadStrategyModel(options.modelPath);
  const entries = parseManifestJsonl(await readFile(options.manifestPath, "utf8"));
  const tournament = evaluateTournamentGate(entries, options);
  const reasons = [...tournament.reasons];
  if (!model.training.offlineGatePassed) {
    reasons.unshift("offline validation gate did not pass");
  }
  const result = {
    ...tournament,
    passed: reasons.length === 0,
    reasons,
  };
  console.log(JSON.stringify({
    event: "model_promotion_gate",
    modelVersion: model.modelVersion,
    ...result,
  }));
  return result;
}

async function main(): Promise<void> {
  const result = await runModelGate(parseModelGateOptions(process.argv.slice(2)));
  if (!result.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
