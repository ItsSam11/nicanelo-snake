import type { Coordinate } from "../api/types.js";
import {
  DIRECTIONS,
  coordinateKey,
  isInsideBoard,
  moveCoordinate,
} from "../domain/board.js";

export interface FloodFillResult {
  reachable: ReadonlySet<string>;
  coordinates: ReadonlyMap<string, Coordinate>;
  distances: ReadonlyMap<string, number>;
  size: number;
  maxDepth: number;
}

function emptyResult(): FloodFillResult {
  return {
    reachable: new Set<string>(),
    coordinates: new Map<string, Coordinate>(),
    distances: new Map<string, number>(),
    size: 0,
    maxDepth: 0,
  };
}

/**
 * Explores every statically reachable cell. The origin itself is always
 * accepted when it is on-board, even if it appears in `blocked`, because snake
 * heads normally occupy their own starting cell.
 */
export function floodFill(
  origin: Coordinate,
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
): FloodFillResult {
  if (!isInsideBoard(origin, width, height)) {
    return emptyResult();
  }

  const originKey = coordinateKey(origin);
  const reachable = new Set<string>([originKey]);
  const coordinates = new Map<string, Coordinate>([[originKey, { ...origin }]]);
  const distances = new Map<string, number>([[originKey, 0]]);
  const queue: Coordinate[] = [{ ...origin }];
  let queueIndex = 0;
  let maxDepth = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (current === undefined) {
      continue;
    }

    const currentDistance = distances.get(coordinateKey(current)) ?? 0;
    for (const direction of DIRECTIONS) {
      const next = moveCoordinate(current, direction);
      const nextKey = coordinateKey(next);
      if (
        !isInsideBoard(next, width, height) ||
        blocked.has(nextKey) ||
        reachable.has(nextKey)
      ) {
        continue;
      }

      const distance = currentDistance + 1;
      reachable.add(nextKey);
      coordinates.set(nextKey, next);
      distances.set(nextKey, distance);
      maxDepth = Math.max(maxDepth, distance);
      queue.push(next);
    }
  }

  return {
    reachable,
    coordinates,
    distances,
    size: reachable.size,
    maxDepth,
  };
}

export function relativeSpace(
  reachableCells: number,
  snakeLength: number,
): number {
  return snakeLength <= 0 ? 0 : reachableCells / snakeLength;
}
