using './training.bicep'

// Select your own immutable dataset and artifact paths outside version control.
param resourceNamePrefix = readEnvironmentVariable('AZURE_RESOURCE_PREFIX')
param location = 'eastus2'
param acrName = readEnvironmentVariable('AZURE_ACR_NAME')
param storageAccountName = readEnvironmentVariable('AZURE_STORAGE_ACCOUNT_NAME')
param imageTag = readEnvironmentVariable('TRAINING_IMAGE_TAG')
param datasetStage = 'pilot'
param selectionId = readEnvironmentVariable('TRAINING_SELECTION_ID')
param modelVersion = readEnvironmentVariable('TRAINING_MODEL_VERSION')
param sourcePrefix = readEnvironmentVariable('TRAINING_SOURCE_PREFIX')
param trainingRootPrefix = readEnvironmentVariable('TRAINING_ROOT_PREFIX')
param preparationShardCount = 60
param workersPerPreparationJob = 31
param trainingWorkers = 31
param trainingEpochs = 200
