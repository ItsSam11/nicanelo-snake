# Azure persistence resources

Azure CLI provisions resources and permissions. The runtime authenticates
through `DefaultAzureCredential` and Microsoft Entra tokens; the Bicep
templates attach user-assigned managed identities to the application and jobs.
Redis stores compact summaries with a TTL, and Blob stores immutable telemetry
events. The commands below describe resource provisioning; deployment
configuration is documented in `infra/README.md`. The manual example below
assigns a system-managed identity to an existing app. For a Bicep deployment,
use the provisioned user-assigned identity and its principal ID.

Keep the subscription value only in the local shell:

```bash
AZURE_SUBSCRIPTION="<subscription id or name>"
RESOURCE_GROUP="<your-resource-group>"
LOCATION="westus2"
APP_NAME="<your-app-name>"
REDIS_NAME="<your-redis-name>"
STORAGE_ACCOUNT="<your-storage-account>"

az account set --subscription "$AZURE_SUBSCRIPTION"
```

The shell variable does not need to be exported. After `az account set`, the
remaining commands use Azure CLI's active subscription without printing its ID.

## Azure Managed Redis

```bash
az extension add --name redisenterprise --upgrade

az redisenterprise create \
  --name "$REDIS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Balanced_B0 \
  --high-availability Disabled \
  --public-network-access Enabled \
  --minimum-tls-version 1.2 \
  --no-database \
  --output none

az redisenterprise database create \
  --cluster-name "$REDIS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --access-keys-authentication Disabled \
  --client-protocol Encrypted \
  --clustering-policy OSSCluster \
  --eviction-policy VolatileTTL \
  --port 10000 \
  --output none
```

Public access plus Entra/TLS is the fast initial path. A VNet-integrated
Container Apps environment and Redis Private Endpoint are the later hardened
network path. Creating the cluster with `--no-database` and then creating the
database avoids a race where the CLI tries to create `default` while the
cluster is still starting.

## Container App identity and Redis access

```bash
APP_PRINCIPAL_ID="$(
  az containerapp identity assign \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --system-assigned \
    --query principalId \
    --output tsv \
    --only-show-errors
)"

az redisenterprise database access-policy-assignment create \
  --resource-group "$RESOURCE_GROUP" \
  --cluster-name "$REDIS_NAME" \
  --database-name default \
  --access-policy-assignment-name battlesnakecontainerapp \
  --access-policy-name default \
  --object-id "$APP_PRINCIPAL_ID" \
  --only-show-errors
```

The assignment name is deliberately alphanumeric: the current CLI extension
rejects hyphens for this field.

## Azure Blob Storage

```bash
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-shared-key-access false \
  --public-network-access Enabled \
  --default-action Allow \
  --output none

az storage container create \
  --account-name "$STORAGE_ACCOUNT" \
  --name battlesnake-corpus \
  --auth-mode login \
  --public-access off \
  --output none

STORAGE_SCOPE="$(
  az storage account show \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --query id \
    --output tsv
)"

az role assignment create \
  --assignee-object-id "$APP_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$STORAGE_SCOPE" \
  --output none
```

## Runtime variables

```bash
REDIS_HOST="$(
  az redisenterprise show \
    --name "$REDIS_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query hostName \
    --output tsv
)"

az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "REDIS_ENABLED=true" \
    "REDIS_ENDPOINT=${REDIS_HOST}:10000" \
    "REDIS_KEY_PREFIX=battlesnake" \
    "REDIS_TTL_SECONDS=1800" \
    "AZURE_BLOB_ENABLED=true" \
    "AZURE_STORAGE_ACCOUNT_URL=https://${STORAGE_ACCOUNT}.blob.core.windows.net" \
    "AZURE_STORAGE_CONTAINER=battlesnake-corpus" \
    "AZURE_STORAGE_PREFIX=telemetry/raw/live" \
  --output none
```

Blob Storage is a separate durable sink and does not connect directly to Redis.
The request path only enqueues persistence after sending the HTTP response;
Redis or Blob failures remain fail-open and never alter the chosen move.
