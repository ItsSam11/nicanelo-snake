using './main.bicep'

// Supply verified deployment values locally; no historical releases are pinned here.
param resourceNamePrefix = readEnvironmentVariable('AZURE_RESOURCE_PREFIX')
param location = 'eastus2'
param resourceGroupName = readEnvironmentVariable('AZURE_RESOURCE_GROUP')
param acrName = readEnvironmentVariable('AZURE_ACR_NAME')
param storageAccountName = readEnvironmentVariable('AZURE_STORAGE_ACCOUNT_NAME')
param redisName = readEnvironmentVariable('AZURE_REDIS_NAME')

// Provision the foundation before enabling compute. Jobs require a separate start.
param deployCompute = false
param deployRedis = false
param appImageTag = readEnvironmentVariable('APP_IMAGE_TAG')
param jobImageTag = readEnvironmentVariable('JOB_IMAGE_TAG')
param zooImageTag = readEnvironmentVariable('COREYJA_IMAGE_TAG')
param snorkImageTag = readEnvironmentVariable('SNORK_IMAGE_TAG')
param nessegrevImageTag = readEnvironmentVariable('NESSEGREV_IMAGE_TAG')
param gymCampaignId = readEnvironmentVariable('GYM_CAMPAIGN_ID')
param gymEngineVersion = readEnvironmentVariable('GYM_ENGINE_VERSION')
param gymJobImageDigest = readEnvironmentVariable('JOB_IMAGE_DIGEST')
param gymSubjectModelSha256 = readEnvironmentVariable('SUBJECT_MODEL_SHA256')
param searchTimeBudgetMs = 350
param searchResponseReserveMs = 100
