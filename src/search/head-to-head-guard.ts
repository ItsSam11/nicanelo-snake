import type {
  Direction,
  GameState,
} from "../api/types.js";
export {
  immediateHeadToHeadOutcome,
  type ImmediateHeadToHeadOutcome,
} from "../domain/head-to-head.js";
import { immediateHeadToHeadOutcome } from "../domain/head-to-head.js";
import { projectOurMove } from "../evaluation/spatial-analysis.js";
import { analyzeTraps } from "../evaluation/traps.js";
import { physicallyViableMoves } from "../strategy/static-policy.js";

/**
 * A guard alternative must avoid an immediate non-winning head collision and
 * retain actual room after moving. This deliberately accepts narrow one-exit
 * positions, but rejects zero-exit or body-sized pockets where replacing a
 * possible collision would merely select another structurally forced loss.
 */
export function isReasonableHeadToHeadAlternative(
  state: GameState,
  move: Direction,
): boolean {
  if (!physicallyViableMoves(state).includes(move)) return false;
  if (immediateHeadToHeadOutcome(state, move) === "losing") return false;

  const projection = projectOurMove(state, move);
  const trap = analyzeTraps(
    projection.snake.head,
    projection.state.board.width,
    projection.state.board.height,
    projection.blocked,
    projection.snake.body.length,
  );
  return projection.snake.health > 0 &&
    trap.hasEnoughSpace &&
    trap.openExits > 0;
}
