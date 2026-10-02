# Azure infrastructure

The Bicep templates define the public service, isolated evaluation Jobs,
internal opponents, Blob persistence, and offline training. Authentication uses
managed identities and Azure RBAC. Historical deployment and campaign profiles
are kept in ignored local configuration; the public repository contains three
configuration examples.

The deployment commands use native Bicep parameter files with Azure CLI 2.53.0
or later and Bicep CLI 0.22 or later; the `using` statement selects the template.
See [the Azure parameter-file documentation](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/parameter-files#azure-cli).

## Public configuration examples

| Example | Template | Purpose |
| --- | --- | --- |
| [`main.example.bicepparam`](main.example.bicepparam) | `main.bicep` | Subscription-level foundation, with compute initially disabled. |
| [`gym.example.bicepparam`](gym.example.bicepparam) | `gym.bicep` | A small evaluation assignment using existing registry and storage resources. |
| [`training.example.bicepparam`](training.example.bicepparam) | `training.bicep` | Pilot dataset preparation and model training on existing gym environments. |

These examples contain no historical campaign IDs, private image tags, or
artifact hashes. Supply verified values locally. Ordinary `infra/*.bicepparam`
files are ignored; `.example.bicepparam` files are the explicit public exception.

`infra/local/` is also ignored and excluded from Docker build contexts. On the
maintainer's machine, it contains the original operational templates and
profiles. `infra/local/publication-backup/` preserves the later public snapshot,
including historical profiles and unedited reports. Neither directory is
included when cloning the public repository.

For an existing deployment, use its own matching templates and resource names.
The generic examples describe a configurable deployment; changing its resource
prefix changes the resources being addressed.

## Local inputs

Use an ignored shell file or export values before compiling. For example:

```bash
export AZURE_RESOURCE_PREFIX="<short-resource-prefix>"
export AZURE_RESOURCE_GROUP="<your-resource-group>"
export AZURE_ACR_NAME="<your-globally-unique-acr-name>"
export AZURE_STORAGE_ACCOUNT_NAME="<your-globally-unique-storage-name>"
export AZURE_REDIS_NAME="<your-redis-name>"
```

`AZURE_RESOURCE_PREFIX` supplies matching names for the service, identities,
logs, Zoo apps, and six gym environments across the foundation, gym, and training
templates. Registry and storage names must be globally unique and are supplied
separately.

The service and evaluation examples also require:

| Variable | Value to supply |
| --- | --- |
| `APP_IMAGE_TAG` | Immutable public-service image tag; required by the main example. |
| `JOB_IMAGE_TAG` | Immutable evaluation Job image tag. |
| `COREYJA_IMAGE_TAG` | Immutable Coreyja opponent image tag. |
| `SNORK_IMAGE_TAG` | Immutable Snork opponent image tag. |
| `NESSEGREV_IMAGE_TAG` | Immutable Nessegrev opponent image tag. |
| `GYM_CAMPAIGN_ID` | A new unique evaluation identifier. |
| `GYM_ENGINE_VERSION` | The engine version actually packaged in the Job image. |
| `JOB_IMAGE_DIGEST` | The verified `sha256:` digest of that exact Job image. |
| `SUBJECT_MODEL_SHA256` | The SHA-256 of the model actually loaded by the subject. |

The examples use the repository defaults in their templates; publish the
selected tags into those repositories. The gym and stack templates expose
repository overrides for an ignored local profile; the main template uses
the stack's repository defaults.
The supplied digest must match the selected image tag. It is recorded as
provenance; the container image itself is selected by its registry/repository/tag.

The training example additionally requires:

| Variable | Value to supply |
| --- | --- |
| `TRAINING_IMAGE_TAG` | Immutable image containing the preparation and training entry points. |
| `TRAINING_SELECTION_ID` | Unique immutable dataset selection identifier. |
| `TRAINING_MODEL_VERSION` | Version of the model being trained. |
| `TRAINING_SOURCE_PREFIX` | Blob prefix containing the validated source corpus. |
| `TRAINING_ROOT_PREFIX` | Separate Blob root for selection, prepared data, and model outputs. |

Bicep resolves these variables during compilation. Generated deployment JSON
contains the supplied values and must stay local; root-level `infra/*.json` is
ignored. Node.js does not automatically load shell files. When the private
configuration exists, load it explicitly with `source infra/local/deployment.env`.
Set any additional image and campaign values required by the selected example.

## Foundation and images

For a new environment, start with compute disabled:

The main example requires image and provenance inputs even when compute is
disabled. For this initial foundation deployment, temporary local values are
sufficient because no compute resources use them. Replace them with verified
build metadata before enabling compute or starting evaluation Jobs.

```bash
az deployment sub create \
  --name nicanelo-foundation \
  --location eastus2 \
  --parameters infra/main.example.bicepparam
```

The example also disables optional Redis. The foundation provisions the
resource group, ACR, private Blob container, Log Analytics workspace, public
Container Apps environment, managed identities, and RBAC assignments. The
application and Job identities can write telemetry; opponent identities can
pull images without accessing Blob data.

Build the public application with `Dockerfile`. Build the opponent images from
the audited source pins in [`zoo/`](zoo/README.md), then build `Dockerfile.job`
with an explicit `COREYJA_IMAGE` reference. Every Azure image must target
`linux/amd64`. Use immutable release tags and verify the resulting image/model
hashes before supplying provenance values. The source pins and terminal-state
patch are public dependency information, independent of private deployment tags.

After the images exist, enable `deployCompute` in an ignored local copy of the
main profile. This also reconciles the gym resources and manual Job definitions.
For an independent evaluation assignment, use the gym example against the
matching registry and storage account:

```bash
az deployment group validate \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --parameters infra/gym.example.bicepparam

az deployment group create \
  --name nicanelo-evaluation \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --parameters infra/gym.example.bicepparam
```

Deploying a manual Job does not start an execution. Choose a new campaign ID
for each run, validate the Jobs and their assignments, and start them separately.

## Game continuity and search budget

The public engine keeps MCTS trees, opponent observations, and tactical state
in process-local maps partitioned by `game.id`. The public Container App is
pinned to one warm replica. Cookie-based ingress affinity does not guarantee
routing by game ID for webhook clients. A process or revision restart can still
discard this optional state; each move can be computed from the full request
payload.

Main and gym templates default to a 350 ms search budget and a 100 ms response
reserve. The service's local default is 150 ms. These are template settings,
not proof of the active deployed configuration; inspect the live revision to
confirm runtime values. Historical latency and strength measurements are
reported in [`reports/`](../reports/).

## Evaluation topology

Coreyja runs as a process inside each manual Job. Its `/start`, `/move`, and
`/end` requests for one game therefore share memory. Snork and Nessegrev run
as internal Container Apps on the Consumption profile, with one pair for each
of the four challenger environments.

Challenger uses four dedicated environments, while Legacy uses two. Each has
its own `D32` workload profile and independent node limit. Jobs run one Nicanelo
process per lane, use disjoint seed ranges and global roster offsets, and write
provenance and telemetry beneath `telemetry/raw/gym/<campaign>/<cohort>/shard-<n>`.
The generic gym example uses 50 games per cohort and two Jobs per legacy
environment: four Challenger Jobs and four Legacy Jobs, with five lanes each.

The stack template retains the larger workload defaults of 20,000 games per
cohort and 30 Jobs per cohort. These are configurable workload sizes, not
historical deployment identifiers. Verify image references, model provenance,
seed distribution, capacity, and workload assignments before executing Jobs.

Inspect execution state without changing it:

```bash
GYM_JOB_NAME="${AZURE_RESOURCE_PREFIX}-gym-challenger-1"

az containerapp job execution list \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$GYM_JOB_NAME" \
  --query '[0].{name:name,status:properties.status,start:properties.startTime,end:properties.endTime}' \
  --output table

az containerapp job logs show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$GYM_JOB_NAME" \
  --container "$GYM_JOB_NAME" \
  --follow --tail 30
```

## Offline training

`training.bicep` creates 60 manual preparation Jobs, plus selector, finalizer,
and trainer control Jobs. They reuse the six gym environments and `GymD32`
profiles. Job definitions do not reserve CPU or memory while idle. Generation
and training share node limits and should run at separate times.

Validate and deploy the configured pilot profile:

```bash
az deployment group validate \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --parameters infra/training.example.bicepparam

az deployment group create \
  --name nicanelo-training \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --parameters infra/training.example.bicepparam
```

Execution order:

1. Start `<resource-prefix>-training-selector` and validate its `_SUCCESS.json`.
2. Start preparation Jobs `<resource-prefix>-training-prep-000` through `-059`;
   all 60 must succeed.
3. Start `<resource-prefix>-training-finalizer`; pilot requires 5,000 training
   games and 2,000 validation games.
4. Start `<resource-prefix>-training-model` and inspect the training summary
   and offline gate.

For main training, use an ignored local profile with `datasetStage='main'` and
new immutable output versions. Main uses 20,000 total training games, including
the pilot 5,000. Keep the 2,000 test games unavailable to the trainer and use
only after selecting the model. See the [offline learning guide](../docs/offline-learning.md).
