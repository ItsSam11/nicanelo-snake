# Deadline-aware Monte Carlo Tree Search

Bounded Monte Carlo Tree Search (MCTS) explores simulated states using the
state evaluator. Each action edge can contain multiple sampled opponent
outcomes. Move selection uses the request payload and process-local memory;
optional persistence runs separately in a background queue.

## Decision flow

1. Compute the static move first. This is the fallback.
2. Derive an internal search budget from the game timeout.
3. Evaluate every physical root action once to build the strategic root prior.
4. Repeatedly select, expand, sample a joint action, roll out, evaluate, and
   backpropagate while time remains.
5. Once every physically viable root candidate has been sampled, use the move
   preferred by MCTS.
6. Return the fallback only when search cannot complete root coverage. An
   optional ablation can restore the former heuristic veto.

The default search budget is the smaller of 150 ms and the game timeout minus a
100 ms reserve. With at least 100 ms available and enough workers to cover the
physical root actions, the pool spends an initial slice on coordinated root
coverage and then gives each worker one focused sample among the strongest
contenders before resuming unconstrained PUCT over the whole root. The coverage
slice includes a small result-delivery reserve, so workers are not cancelled at
the same instant their search budget expires. A statistically separated leader
may return after coverage; ambiguous positions use the remaining budget.
A zero or exhausted budget returns the fallback without
starting a tree search. The fallback remains conservative, but it does not
limit the tree: MCTS always considers every physically viable root move,
including a disputed head-to-head or food cell. Search is skipped only when
the ruleset is unsupported, the game is over, or no compute budget remains.
If every physical move is fatal, the tree still samples all four protocol
directions so the simulator can value the terminal outcomes exactly.

The ruleset gate accepts Standard positions independently of roster size. The
same search path is covered for two, three, and four living snakes; `standard`
does not mean that the position must be a four-player free-for-all.

## Coordinated root search and final arbitration

With four workers, each worker still owns a private persistent tree; there is
no shared mutable tree. The coordinator does share one piece of analysis: it
computes the strategic root prior once per turn and sends the same serializable
probabilities to every worker. This avoids repeating the full candidate
evaluator four times and gives all private trees the same strategic starting
point. The pool then coordinates them in two bounded stages:

1. Assign every physical root move to at least one worker for an initial
   coverage slice. This also revives an expanded action whose decayed visit
   count reached zero.
2. Aggregate that evidence, assign one focused sample per worker among the
   strongest contenders, then release every worker back to normal PUCT across
   the full root. The second stage therefore deepens promising lines without
   making raw visits a proxy for simulation speed.

Coverage may end the search early only when every move has at least 16 samples,
the selected move is also the risk-adjusted leader, and its 95% lower bound is
at least `0.10` above every alternative's upper bound. Otherwise the pool uses
the remaining request budget.

The normal final decision remains the visit leader. A different action can
override it only with at least 32 visits, a risk-adjusted advantage of at least
`0.25`, and a forced-loss-rate advantage of at least `0.20`. This narrow rule
prevents a strongly biased prior from preserving an overwhelmingly fatal move
while leaving ordinary PUCT decisions unchanged. Root statistics remain sorted
by visits for diagnostics; they are not reordered to hide an override.

After MCTS or fallback has proposed a move, an exact root-safety arbiter checks
all joint opponent replies for Standard positions with at most three rivals.
It vetoes the proposal only when its adversarial worst case has no physical
continuation and another move preserves at least one continuation against every
nonterminal reply, or wins terminally. If every move is exposed, or the
proposal is already admissible, the existing tactical/MCTS decision is
preserved. Set
`SEARCH_ROOT_SAFETY_ARBITER=false` only to reproduce the unchanged R7 baseline.

The optional `SEARCH_ROOT_BRANCHING_RESERVE=true` extension runs only after the
hard arbiter would accept the proposal. It intervenes in a narrowly enclosed
`SURVIVE` position when the proposal guarantees only one following move and a
policy-ranked alternative guarantees at least two, preserves terminal wins and
food progress, improves the configured evaluator and mobility, and does not
abandon a critical resource route or a winning head-to-head. It is disabled by
default and remains an experimental paired-evaluation flag.

Policy targets use `puct-policy-target-v4`. Root-risk and root-safety overridden
decisions remain in the auditable corpus but are ineligible for policy-prior
fitting, so training does not imitate either rejected proposal.

When a persistent tree is re-rooted, its accumulated visits and values remain
available, but the real root's priors are refreshed for the current turn. Both
already-expanded action priors and the ordering of unexpanded actions receive
the new probabilities; stale strategic preferences therefore do not survive
only because their subtree was reusable.

## Tree and chance policy

Decision selection uses PUCT with a versioned policy prior:

```text
mean_value + c_puct * prior * sqrt(parent_visits) / (1 + action_visits)
```

The adaptive-control baseline supplies a PUCT constant of `1.15`; the
low-level search fallback remains `1.25` when no model search option is
provided. Expansion takes the highest-prior unvisited move. Each action stores
a map of sampled successor states, so repeated
traversals can reach different rival moves and different Standard-map food
spawns for the same move. Rollouts sample Nicanelo's moves from the loaded
policy prior, rival moves from the seeded opponent model, and food according to
`minimumFood` and `foodSpawnChance`. Setting `SEARCH_ROLLOUT_POLICY=uniform`
restores uniform Nicanelo rollout moves for an ablation or rollback.

A fixed board, seed, iteration count, and configuration produce the same
result. A wall-clock budget may complete a slightly different iteration count
between runs.

The real root does not reuse the imitation-oriented move prior used deeper in
the tree. It scores each physical move with the full evaluator, including trap
safety, mobility, territory, opponent pressure, head-to-head control, and food
access. Strategic posture continuously shifts emphasis from escape toward
territory, pressure, controlled growth, and elimination when Nicanelo has
enough safety capital. The loaded model still controls this calculation: each
feature's strategic coefficient is scaled by the ratio between its model
weight and the default evaluation weight, clamped to `[0.5, 2]`. This bounded
scaling lets a selected value baseline influence exploration without allowing
one coefficient to monopolize PUCT before simulations provide evidence.

PUCT and final root statistics use a posture-aware downside adjustment. Higher
initiative can reduce the penalty on downside variance by at most 50%, so a
promising offensive line is not discarded merely for having a wider range of
non-terminal outcomes. The forced-loss penalty is never relaxed: initiative
does not make a demonstrated death rate acceptable.

Known wins, losses, and draws map to rewards `1`, `-1`, and `0`. Ongoing leaf
states use the centralized evaluator on the centered value-training scale:
`tanh(2 * score / totalAbsoluteNonTerminalWeight)`. This is equivalent to
centering the training model's `sigmoid(4 * score / scale)` win probability
around zero. It keeps non-terminal values comparable with terminal outcomes
and lets MCTS override an attractive one-turn heuristic when deeper simulation
finds a better line.

Ongoing leaves also receive a bounded `0.12` elimination-progress bonus. The
credit is proportional to the fraction of the root's rivals that disappeared,
so removing one rival matters more in a three-snake position than in a
four-snake position. It never modifies terminal win, loss, or draw values, and
the tree is not reused across a change in root opponent count. The option
`eliminationProgressBonus` can tune or disable this term.

## Opponent uncertainty

Each rival receives a probability distribution over physically viable moves.
The policy considers mobility, food urgency, head-to-head safety, hazards, and
wall distance. Opponent moves are sampled independently to avoid enumerating
the exponential joint-action space.

Completed-turn behavior history conditions those probabilities. In
particular, when food is disputed, a rival with a confident aggressive profile
can receive a higher probability of entering the contest; MCTS then evaluates
our food or attack line across that increased risk rather than applying a
separate heuristic veto.

This independence assumption is an approximation: rivals can react to the
same contested cells, but their choices are not modeled as a coordinated
strategy. Details live in `docs/opponent-policy.md`.

## Optional fallback-protection ablation

The search must sample every root action before it can affect the response.
After that, MCTS is authoritative by default. Setting
`SEARCH_FALLBACK_PROTECTION=true` (or `fallbackProtection: true`) restores the
former static-policy veto: a differing MCTS move then needs the configured
mean-value improvement, `0.05` by default. A rejected result sets
`fallbackProtected` in diagnostics.

The strategic real-root prior is enabled by default. Setting
`SEARCH_STRATEGIC_ROOT_PRIOR=false` (or `strategicRootPrior: false`) restores
the lightweight policy prior at the root for an ablation. Internal MCTS nodes
continue to use that lightweight policy in either mode; the full evaluator is
intentionally paid only once at the real root.

## Configuration and diagnostics

`searchMove` accepts:

- `timeBudgetMs`;
- `maxIterations`;
- `maxTreeDepth`;
- `rolloutDepth`;
- `puctConstant` (`explorationConstant` remains a compatibility alias);
- `strategicRootPrior` (enabled by default) and the pool-internal serialized
  `rootPolicyPrior`;
- `fallbackProtection` (disabled by default);
- `simulateFoodSpawns` (enabled by default for the Standard map);
- `minimumRootImprovement`;
- `eliminationProgressBonus` (`0.12` by default);
- `seed`;
- opponent-policy temperature and weights;
- policy-prior temperature and weights;
- `rolloutPolicy` (`policy` or `uniform`);
- whether a tree may survive an opponent-context update and the retained
  statistics fraction;
- an injectable monotonic `now` clock for deadline tests.

It reports iterations, elapsed time, deadline status, whether root search was
complete, whether the optional fallback gate protected the decision, and
per-root move visits, mean value, and distinct sampled outcome count.

The deterministic turn simulator still excludes random food spawning because
the API payload does not contain the engine RNG state. MCTS layers a seeded
stochastic Standard-map food transition on top of that exact deterministic
turn. This keeps unit simulation auditable while allowing search to evaluate
multiple plausible future food layouts. `SEARCH_SIMULATE_FOOD_SPAWNS=false`
restores the previous deterministic-transition behavior for an ablation.
