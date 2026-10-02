import type { Coordinate, GameState } from "../api/types.js";
import {
  coordinateKey,
  DIRECTIONS,
  guaranteedOccupiedCells,
  isInsideBoard,
  moveCoordinate,
} from "../domain/board.js";
import { floodFill } from "./flood-fill.js";

export interface TerritoryAnalysis {
  ownedBySnake: ReadonlyMap<string, ReadonlySet<string>>;
  ownerByCell: ReadonlyMap<string, string>;
  contested: ReadonlySet<string>;
  unreachable: ReadonlySet<string>;
}

function bodyCells(state: GameState): Set<string> {
  return guaranteedOccupiedCells(state);
}

/** Earliest turn on which a body cell clears if nobody eats meanwhile. */
export function bodyReleaseTurns(state: Readonly<GameState>): ReadonlyMap<string, number> {
  const release = new Map<string, number>();
  for (const snake of state.board.snakes) {
    for (let index = 0; index < snake.body.length; index += 1) {
      const key = coordinateKey(snake.body[index]!);
      const turns = snake.body.length - index;
      release.set(key, Math.max(release.get(key) ?? 0, turns));
    }
  }
  return release;
}

interface TimedCell {
  key: string;
  coordinate: Coordinate;
}

function releaseAwareDistances(
  origin: Readonly<Coordinate>,
  width: number,
  height: number,
  release: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const originKey = coordinateKey(origin);
  const distances = new Map<string, number>([[originKey, 0]]);
  const maximumRelease = Math.max(0, ...release.values());
  const horizon = width * height + maximumRelease;
  const frontier = Array.from(
    { length: horizon + 1 },
    () => [] as TimedCell[],
  );
  frontier[0]!.push({
    key: originKey,
    coordinate: { ...origin },
  });

  for (let turn = 0; turn <= horizon; turn += 1) {
    for (const current of frontier[turn]!) {
      if (turn !== distances.get(current.key)) continue;
      for (const direction of DIRECTIONS) {
        const candidate = moveCoordinate(current.coordinate, direction);
        if (!isInsideBoard(candidate, width, height)) continue;
        const key = coordinateKey(candidate);
        const arrival = Math.max(turn + 1, release.get(key) ?? 0);
        if (
          arrival > horizon ||
          arrival >= (distances.get(key) ?? Number.POSITIVE_INFINITY)
        ) continue;
        distances.set(key, arrival);
        frontier[arrival]!.push({ key, coordinate: candidate });
      }
    }
  }
  return distances;
}

function territoryFromDistances(
  state: GameState,
  distancesBySnake: ReadonlyMap<string, ReadonlyMap<string, number>>,
): TerritoryAnalysis {
  const ownedBySnake = new Map<string, Set<string>>(
    state.board.snakes.map((snake) => [snake.id, new Set<string>()]),
  );
  const ownerByCell = new Map<string, string>();
  const contested = new Set<string>();
  const unreachable = new Set<string>();

  for (let x = 0; x < state.board.width; x += 1) {
    for (let y = 0; y < state.board.height; y += 1) {
      const key = coordinateKey({ x, y });
      let minimumDistance = Number.POSITIVE_INFINITY;
      const closest: string[] = [];

      for (const snake of state.board.snakes) {
        const distance = distancesBySnake.get(snake.id)?.get(key);
        if (distance === undefined) continue;
        if (distance < minimumDistance) {
          minimumDistance = distance;
          closest.length = 0;
          closest.push(snake.id);
        } else if (distance === minimumDistance) {
          closest.push(snake.id);
        }
      }

      if (closest.length === 0) {
        unreachable.add(key);
      } else if (closest.length > 1) {
        const contenders = closest
          .map((id) => state.board.snakes.find((snake) => snake.id === id))
          .filter((snake) => snake !== undefined);
        const longest = Math.max(...contenders.map((snake) => snake.length));
        const longestContenders = contenders.filter(
          (snake) => snake.length === longest,
        );
        if (longestContenders.length === 1) {
          const owner = longestContenders[0]?.id;
          if (owner !== undefined) {
            ownerByCell.set(key, owner);
            ownedBySnake.get(owner)?.add(key);
          }
        } else {
          contested.add(key);
        }
      } else {
        const owner = closest[0];
        if (owner !== undefined) {
          ownerByCell.set(key, owner);
          ownedBySnake.get(owner)?.add(key);
        }
      }
    }
  }

  return { ownedBySnake, ownerByCell, contested, unreachable };
}

/**
 * Assigns each reachable cell to the uniquely closest snake head. When arrival
 * distance ties, a unique longest contender owns the cell because it controls
 * the corresponding head-to-head; equal longest contenders remain contested.
 */
export function analyzeTerritory(
  state: GameState,
  blocked: ReadonlySet<string> = bodyCells(state),
): TerritoryAnalysis {
  const distancesBySnake = new Map<string, ReadonlyMap<string, number>>();

  for (const snake of state.board.snakes) {
    distancesBySnake.set(
      snake.id,
      floodFill(
        snake.head,
        state.board.width,
        state.board.height,
        blocked,
      ).distances,
    );
  }
  return territoryFromDistances(state, distancesBySnake);
}

/** Territory using body-release timing instead of treating every body as permanent. */
export function analyzeReleaseAwareTerritory(
  state: GameState,
): TerritoryAnalysis {
  const release = bodyReleaseTurns(state);
  return territoryFromDistances(
    state,
    new Map(state.board.snakes.map((snake) => [
      snake.id,
      releaseAwareDistances(
        snake.head,
        state.board.width,
        state.board.height,
        release,
      ),
    ])),
  );
}

export function territoryCount(
  analysis: TerritoryAnalysis,
  snakeId: string,
): number {
  return analysis.ownedBySnake.get(snakeId)?.size ?? 0;
}

const STATIC_BODY_TERRITORY_WEIGHT = 0.35;
const OPEN_TERRITORY_WEIGHT = 0.325;
const RELEASE_AWARE_TERRITORY_WEIGHT = 0.325;

function strongestOpponentTerritory(
  state: Readonly<GameState>,
  analysis: Readonly<TerritoryAnalysis>,
  perspectiveId: string,
): number {
  return Math.max(
    0,
    ...state.board.snakes
      .filter((snake) => snake.id !== perspectiveId)
      .map((snake) => territoryCount(analysis, snake.id)),
  );
}

/**
 * Blends static body-constrained territory, a fully open head race, and a
 * release-aware race. Static space detects immediate denial, open space
 * dampens turn-to-turn body-wall cliffs, and release timing prevents deep body
 * segments from becoming instant corridors.
 */
export function blendedTerritoryAdvantage(
  state: GameState,
  perspectiveId: string,
  blocked: ReadonlySet<string> = bodyCells(state),
): number {
  const constrained = analyzeTerritory(state, blocked);
  const open = analyzeTerritory(state, new Set<string>());
  const releaseAware = analyzeReleaseAwareTerritory(state);
  const constrainedDifference = territoryCount(constrained, perspectiveId) -
    strongestOpponentTerritory(state, constrained, perspectiveId);
  const openDifference = territoryCount(open, perspectiveId) -
    strongestOpponentTerritory(state, open, perspectiveId);
  const releaseAwareDifference = territoryCount(
    releaseAware,
    perspectiveId,
  ) - strongestOpponentTerritory(state, releaseAware, perspectiveId);
  const area = Math.max(state.board.width * state.board.height, 1);
  return (
    STATIC_BODY_TERRITORY_WEIGHT * constrainedDifference +
    OPEN_TERRITORY_WEIGHT * openDifference +
    RELEASE_AWARE_TERRITORY_WEIGHT * releaseAwareDifference
  ) / area;
}
