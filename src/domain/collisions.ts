import type { Battlesnake } from "../api/types.js";
import { isInsideBoard, sameCoordinate } from "./board.js";

export type EliminationCause =
  | "hazard"
  | "out-of-health"
  | "out-of-bounds"
  | "self-collision"
  | "body-collision"
  | "head-to-head";

export interface SnakeElimination {
  snakeId: string;
  cause: EliminationCause;
  bySnakeId?: string;
}

function elimination(
  snakeId: string,
  cause: EliminationCause,
  bySnakeId?: string,
): SnakeElimination {
  return bySnakeId === undefined
    ? { snakeId, cause }
    : { snakeId, cause, bySnakeId };
}

/** Health and bounds are resolved before any collision checks. */
export function findNonCollisionEliminations(
  snakes: readonly Battlesnake[],
  width: number,
  height: number,
): SnakeElimination[] {
  return snakes.flatMap((snake) => {
    if (snake.health <= 0) {
      return [elimination(snake.id, "out-of-health")];
    }

    const outside = snake.body.some(
      (segment) => !isInsideBoard(segment, width, height),
    );
    return outside ? [elimination(snake.id, "out-of-bounds")] : [];
  });
}

function hasBodyCollision(
  snake: Battlesnake,
  other: Battlesnake,
): boolean {
  return other.body
    .slice(1)
    .some((segment) => sameCoordinate(snake.head, segment));
}

function losesHeadToHead(
  snake: Battlesnake,
  other: Battlesnake,
): boolean {
  return (
    sameCoordinate(snake.head, other.head) &&
    snake.body.length <= other.body.length
  );
}

/**
 * Finds collision deaths without applying them until every snake has been
 * checked. This preserves simultaneous resolution: a snake killed by a
 * collision remains an obstacle for the other collision checks that turn.
 */
export function findCollisionEliminations(
  snakes: readonly Battlesnake[],
): SnakeElimination[] {
  const snakesByLength = snakes
    .map((snake, index) => ({ snake, index }))
    .sort(
      (a, b) =>
        b.snake.body.length - a.snake.body.length || a.index - b.index,
    )
    .map(({ snake }) => snake);

  const eliminations: SnakeElimination[] = [];

  for (const snake of snakes) {
    if (hasBodyCollision(snake, snake)) {
      eliminations.push(
        elimination(snake.id, "self-collision", snake.id),
      );
      continue;
    }

    const bodyOwner = snakesByLength.find(
      (other) => other.id !== snake.id && hasBodyCollision(snake, other),
    );
    if (bodyOwner !== undefined) {
      eliminations.push(
        elimination(snake.id, "body-collision", bodyOwner.id),
      );
      continue;
    }

    const headToHeadWinner = snakesByLength.find(
      (other) => other.id !== snake.id && losesHeadToHead(snake, other),
    );
    if (headToHeadWinner !== undefined) {
      eliminations.push(
        elimination(snake.id, "head-to-head", headToHeadWinner.id),
      );
    }
  }

  return eliminations;
}
