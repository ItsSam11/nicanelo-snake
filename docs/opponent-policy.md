# Probabilistic opponent policy

The opponent policy models each living rival as a categorical distribution over its
physically viable directions. It predicts decisions from the current request;
it does not fetch positions or other data externally. The generic five-feature
policy remains the zero-history fallback.

For every candidate direction the policy calculates normalized features:

- immediate mobility after moving;
- health-, route-, and space-weighted access to food, including moderate
  maintenance eating and only local equal-length tactical growth;
- safety from equal-or-longer head-to-head threats;
- avoidance of non-lethal hazard damage;
- distance from the nearest wall.

Four optional interaction features compare each candidate action with the
rival's opportunity-conditioned history: aggression, resource acquisition,
health management, and conservatism. The history is updated only from completed
earlier turns. Each interaction is scaled by per-dimension confidence, so a new
or out-of-distribution opponent starts at the generic policy instead of being
forced into a profile.

The interaction applies to food and attacks together. A food cell adjacent to
another head is both a resource decision and a possible aggressive contest.
When the fitted aggression influence is positive, a confidently aggressive rival is
therefore sampled into that food contest more often than a conservative one.
The direction and magnitude remain model parameters rather than a hard-coded
identity rule.

The weighted feature sum becomes a logit. Stable softmax converts the logits
to probabilities:

```text
P(move_i) = exp((score_i - max_score) / temperature) / sum(exp(...))
```

Subtracting the maximum score prevents numeric overflow. Temperature controls
uncertainty: lower values concentrate probability around the highest-scoring
move, while higher values flatten the distribution.

The main evaluator uses exact flood-fill space and a survivable food route.
Because the opponent policy runs inside every MCTS simulation, it uses a
constant-time board-capacity and local-exit approximation instead of another
flood fill for every rival. This keeps the spatial appetite signal without
consuming most of the search budget.

Opponent choices are sampled independently to form a joint action. This avoids
enumerating up to `4^n` combinations for `n` opponents. The turn simulator then
resolves the sampled joint action simultaneously.

MCTS stores multiple sampled outcomes under the same action edge. Action visit
counts and values aggregate over those outcomes, so a move is judged across
several plausible rival responses rather than one fixed prediction.

The default adaptive model includes manually tuned contextual weights. A
trained artifact may fit them from observed opponent moves, but promotion
requires lower held-out opponent negative log-likelihood without a material
Brier-score regression. Snake IDs and names are metadata and never model
features.
