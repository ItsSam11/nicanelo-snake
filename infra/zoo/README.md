# Audited Snake Zoo images

These images are built from immutable upstream commits recorded in
`sources.json`. Opponent source stays outside the Nicanelo runtime image and
receives no Blob Storage identity.

`coreyja-hobbs-terminal.patch` makes two bounded reliability changes to
Hovering Hobbs. The official local rules CLI may ask the sole survivor for one
final move; upstream panics because minimax correctly has no child, so the
patch returns a protocol-valid move in that state. It also increases Hobbs'
network/response reserve from 150 ms to 350 ms because its iterative minimax
step can overrun the nominal cutoff under concurrent Azure load.

Coreyja is copied into the managed Job image and runs on loopback. Hobbs keeps
per-game state in process memory, so it must not sit behind a multi-replica HTTP
load balancer. Snork and Nessegrev remain separate internal Container Apps.

Build immutable Azure images from the repository root after setting
`AZURE_ACR_NAME`, `COREYJA_IMAGE_TAG`, `SNORK_IMAGE_TAG`, and
`NESSEGREV_IMAGE_TAG` locally (see [the infrastructure guide](../README.md)):

```bash
az acr build --registry "$AZURE_ACR_NAME" \
  --file infra/zoo/coreyja.Dockerfile \
  --image "snake-zoo-coreyja:${COREYJA_IMAGE_TAG}" .

az acr build --registry "$AZURE_ACR_NAME" \
  --file infra/zoo/snork.Dockerfile \
  --image "snake-zoo-snork:${SNORK_IMAGE_TAG}" .

az acr build --registry "$AZURE_ACR_NAME" \
  --file infra/zoo/nessegrev.Dockerfile \
  --image "snake-zoo-nessegrev:${NESSEGREV_IMAGE_TAG}" .
```

Do not reuse these tags for later source commits or local patches.
