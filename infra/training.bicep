targetScope = 'resourceGroup'

@description('Deployment-specific resource prefix shared by foundation, gym, and training.')
param resourceNamePrefix string

@description('Training Jobs reuse the six existing D32 gym environments and allocate no nodes until execution.')
param location string = resourceGroup().location
param acrName string
param storageAccountName string
param blobContainerName string = 'battlesnake-corpus'
param jobIdentityName string = '${resourceNamePrefix}-gym-jobs-identity'
param workloadProfileName string = 'GymD32'
param imageRepository string = 'elaniin-battlesnake'
param imageTag string

param challengerEnvironmentAName string = '${resourceNamePrefix}-gym-challenger-a-${location}'
param challengerEnvironmentBName string = '${resourceNamePrefix}-gym-challenger-b-${location}'
param challengerEnvironmentCName string = '${resourceNamePrefix}-gym-challenger-c-${location}'
param challengerEnvironmentDName string = '${resourceNamePrefix}-gym-challenger-d-${location}'
param legacyEnvironmentAName string = '${resourceNamePrefix}-gym-legacy-a-${location}'
param legacyEnvironmentBName string = '${resourceNamePrefix}-gym-legacy-b-${location}'

@allowed([
  'pilot'
  'main'
])
param datasetStage string = 'pilot'
param selectionId string
param modelVersion string
param sourcePrefix string
param trainingRootPrefix string
param selectionVersion string = 'selection-v1'
param preparedVersion string = 'prepared-v1'
param modelRunVersion string = 'run-v1'
param preparationShardCount int = 60
param workersPerPreparationJob int = 31
param trainingWorkers int = 31
param trainingEpochs int = 200

var environmentNames = [
  challengerEnvironmentAName
  challengerEnvironmentBName
  challengerEnvironmentCName
  challengerEnvironmentDName
  legacyEnvironmentAName
  legacyEnvironmentBName
]
var accountUrl = 'https://${storageAccountName}.blob.${az.environment().suffixes.storage}'
var selectionPrefix = '${trainingRootPrefix}/selection/${selectionVersion}'
var preparedPrefix = '${trainingRootPrefix}/prepared/${datasetStage}/${preparedVersion}'
var modelOutputPrefix = '${trainingRootPrefix}/models/${datasetStage}/${modelRunVersion}'
var modelMinimumGames = datasetStage == 'pilot' ? 5000 : 20000

// The mapping exactly matches the six environment limits used by the 60-game
// generation Jobs: 8 + 8 + 7 + 7 challenger, then 15 + 15 legacy.
var preparationPlans = [for index in range(0, 60): {
  index: index
  environmentIndex: index < 8 ? 0 : index < 16 ? 1 : index < 23 ? 2 : index < 30 ? 3 : index < 45 ? 4 : 5
}]

module selector './training-job.bicep' = {
  name: 'training-selector'
  params: {
    location: location
    acrName: acrName
    environmentName: environmentNames[0]
    workloadProfileName: workloadProfileName
    jobIdentityName: jobIdentityName
    jobName: '${resourceNamePrefix}-training-selector'
    imageRepository: imageRepository
    imageTag: imageTag
    command: [
      'node'
      'dist/src/training/azure-training-selection.js'
    ]
    environmentVariables: [
      { name: 'AZURE_STORAGE_ACCOUNT_URL', value: accountUrl }
      { name: 'AZURE_STORAGE_CONTAINER', value: blobContainerName }
      { name: 'TRAINING_SOURCE_PREFIX', value: sourcePrefix }
      { name: 'TRAINING_SELECTION_PREFIX', value: selectionPrefix }
      { name: 'TRAINING_SELECTION_ID', value: selectionId }
      { name: 'TRAINING_PILOT_GAMES_PER_COHORT', value: '2500' }
      { name: 'TRAINING_MAIN_GAMES_PER_COHORT', value: '10000' }
      { name: 'TRAINING_VALIDATION_GAMES_PER_COHORT', value: '1000' }
      { name: 'TRAINING_TEST_GAMES_PER_COHORT', value: '1000' }
      { name: 'TRAINING_PREPARATION_SHARDS', value: string(preparationShardCount) }
      { name: 'TRAINING_DOWNLOAD_CONCURRENCY', value: '32' }
    ]
  }
}

module preparation './training-job.bicep' = [for plan in preparationPlans: {
  name: 'training-preparation-${plan.index}'
  params: {
    location: location
    acrName: acrName
    environmentName: environmentNames[plan.environmentIndex]
    workloadProfileName: workloadProfileName
    jobIdentityName: jobIdentityName
    jobName: '${resourceNamePrefix}-training-prep-${padLeft(string(plan.index), 3, '0')}'
    imageRepository: imageRepository
    imageTag: imageTag
    command: [
      'node'
      'dist/src/training/azure-prepare-training.js'
    ]
    environmentVariables: [
      { name: 'AZURE_STORAGE_ACCOUNT_URL', value: accountUrl }
      { name: 'AZURE_STORAGE_CONTAINER', value: blobContainerName }
      { name: 'TRAINING_SELECTION_MANIFEST_BLOB', value: '${selectionPrefix}/manifest.jsonl' }
      { name: 'TRAINING_SELECTION_SUCCESS_BLOB', value: '${selectionPrefix}/_SUCCESS.json' }
      { name: 'TRAINING_PREPARED_PREFIX', value: preparedPrefix }
      { name: 'TRAINING_DATASET_STAGE', value: datasetStage }
      { name: 'TRAINING_PREPARATION_SHARD_INDEX', value: string(plan.index) }
      { name: 'TRAINING_PREPARATION_SHARD_COUNT', value: string(preparationShardCount) }
      { name: 'TRAINING_WORKERS', value: string(workersPerPreparationJob) }
      { name: 'TRAINING_UPLOAD_CONCURRENCY', value: '8' }
    ]
  }
}]

module finalizer './training-job.bicep' = {
  name: 'training-finalizer'
  params: {
    location: location
    acrName: acrName
    environmentName: environmentNames[0]
    workloadProfileName: workloadProfileName
    jobIdentityName: jobIdentityName
    jobName: '${resourceNamePrefix}-training-finalizer'
    imageRepository: imageRepository
    imageTag: imageTag
    command: [
      'node'
      'dist/src/training/azure-finalize-training.js'
    ]
    environmentVariables: [
      { name: 'AZURE_STORAGE_ACCOUNT_URL', value: accountUrl }
      { name: 'AZURE_STORAGE_CONTAINER', value: blobContainerName }
      { name: 'TRAINING_SELECTION_MANIFEST_BLOB', value: '${selectionPrefix}/manifest.jsonl' }
      { name: 'TRAINING_PREPARED_PREFIX', value: preparedPrefix }
      { name: 'TRAINING_DATASET_STAGE', value: datasetStage }
      { name: 'TRAINING_PREPARATION_SHARD_COUNT', value: string(preparationShardCount) }
      { name: 'TRAINING_EXPECTED_TRAINING_GAMES', value: string(modelMinimumGames) }
      { name: 'TRAINING_EXPECTED_VALIDATION_GAMES', value: '2000' }
      { name: 'TRAINING_VALIDATION_CONCURRENCY', value: '16' }
    ]
  }
}

module trainer './training-job.bicep' = {
  name: 'training-model'
  params: {
    location: location
    acrName: acrName
    environmentName: environmentNames[0]
    workloadProfileName: workloadProfileName
    jobIdentityName: jobIdentityName
    jobName: '${resourceNamePrefix}-training-model'
    imageRepository: imageRepository
    imageTag: imageTag
    command: [
      'node'
      'dist/src/training/azure-train-model.js'
    ]
    environmentVariables: [
      { name: 'AZURE_STORAGE_ACCOUNT_URL', value: accountUrl }
      { name: 'AZURE_STORAGE_CONTAINER', value: blobContainerName }
      { name: 'TRAINING_PREPARED_PREFIX', value: preparedPrefix }
      { name: 'TRAINING_MODEL_OUTPUT_PREFIX', value: modelOutputPrefix }
      { name: 'TRAINING_MODEL_VERSION', value: modelVersion }
      { name: 'TRAINING_WORKERS', value: string(trainingWorkers) }
      { name: 'TRAINING_EPOCHS', value: string(trainingEpochs) }
      { name: 'TRAINING_MINIMUM_GAMES', value: string(modelMinimumGames) }
    ]
  }
}

output selectorJob string = selector.outputs.name
output preparationJobs array = [for index in range(0, 60): preparation[index].outputs.name]
output finalizerJob string = finalizer.outputs.name
output trainerJob string = trainer.outputs.name
output selectionPrefix string = selectionPrefix
output preparedPrefix string = preparedPrefix
output modelOutputPrefix string = modelOutputPrefix
