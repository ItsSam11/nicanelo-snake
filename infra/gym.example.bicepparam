using './gym.bicep'

// Use a new campaign ID and verified artifact references for each evaluation.
param resourceNamePrefix = readEnvironmentVariable('AZURE_RESOURCE_PREFIX')
param location = 'eastus2'
param acrName = readEnvironmentVariable('AZURE_ACR_NAME')
param storageAccountName = readEnvironmentVariable('AZURE_STORAGE_ACCOUNT_NAME')
param jobImageTag = readEnvironmentVariable('JOB_IMAGE_TAG')
param zooImageTag = readEnvironmentVariable('COREYJA_IMAGE_TAG')
param snorkImageTag = readEnvironmentVariable('SNORK_IMAGE_TAG')
param nessegrevImageTag = readEnvironmentVariable('NESSEGREV_IMAGE_TAG')
param campaignId = readEnvironmentVariable('GYM_CAMPAIGN_ID')
param engineVersion = readEnvironmentVariable('GYM_ENGINE_VERSION')
param jobImageDigest = readEnvironmentVariable('JOB_IMAGE_DIGEST')
param subjectModelSha256 = readEnvironmentVariable('SUBJECT_MODEL_SHA256')

// Small illustrative assignment; manual Jobs do not run on deployment.
param gamesPerCohort = 50
param jobsPerEnvironment = 2
param lanesPerJob = 5
param baseSeed = 1
param searchTimeBudgetMs = 350
param searchResponseReserveMs = 100
param rootSafetyArbiter = true
param rootBranchingReserve = false
