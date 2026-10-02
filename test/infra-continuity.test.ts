import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function repositoryFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("production game continuity configuration", () => {
  it("keeps the stateful public engine on one warm replica", () => {
    const stack = repositoryFile("infra/stack.bicep");

    assert.match(
      stack,
      /maxReplicas:\s*1\s+minReplicas:\s*1/u,
      "horizontal replicas break process-local game.id continuity",
    );
    assert.match(stack, /value:\s*string\(searchTimeBudgetMs\)/u);
    assert.match(stack, /value:\s*string\(searchResponseReserveMs\)/u);
  });

  it("keeps service and gym examples within the shared move deadline", () => {
    const production = repositoryFile("infra/main.example.bicepparam");
    const gym = repositoryFile("infra/gym.example.bicepparam");
    const gymTemplate = repositoryFile("infra/gym.bicep");

    assert.match(production, /param searchTimeBudgetMs = 350/u);
    assert.match(production, /param searchResponseReserveMs = 100/u);
    assert.match(gym, /param searchTimeBudgetMs = 350/u);
    assert.match(gym, /param searchResponseReserveMs = 100/u);
    assert.match(gymTemplate, /param searchTimeBudgetMs int = 350/u);
    assert.match(gymTemplate, /param searchResponseReserveMs int = 100/u);
    assert.match(gymTemplate, /param rootSafetyArbiter bool = true/u);
    assert.match(gymTemplate, /param rootBranchingReserve bool = false/u);
  });

  it("pins the root-safety ablation explicitly in isolated gym jobs", () => {
    const gym = repositoryFile("infra/gym.bicep");
    const job = repositoryFile("infra/gym-job.bicep");

    assert.match(gym, /rootSafetyArbiter:\s*rootSafetyArbiter/u);
    assert.match(gym, /rootBranchingReserve:\s*rootBranchingReserve/u);
    assert.match(job, /name:\s*'SEARCH_ROOT_SAFETY_ARBITER'/u);
    assert.match(job, /name:\s*'SEARCH_ROOT_BRANCHING_RESERVE'/u);
    assert.match(
      job,
      /value:\s*rootSafetyArbiter\s*\?\s*'true'\s*:\s*'false'/u,
      "the runtime parser requires lowercase boolean strings",
    );
    assert.match(
      job,
      /value:\s*rootBranchingReserve\s*\?\s*'true'\s*:\s*'false'/u,
      "the branching-reserve parser also requires lowercase booleans",
    );
  });
});
