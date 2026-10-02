targetScope = 'resourceGroup'

param location string
param acrName string
param storageAccountName string
param environmentName string
param workloadProfileName string
param jobIdentityName string
param jobName string
param imageRepository string
param imageTag string
param blobContainerName string
param games int
param lanes int
@minValue(1)
param gameAttempts int = 3
param baseSeed int
param gameIndexOffset int
param runId string
param storagePrefix string
param subjectModelVersion string
param modelPath string = '/app/models/heuristic-adaptive-control-v1.json'
@minValue(0)
@maxValue(350)
param searchTimeBudgetMs int = 350
@minValue(0)
@maxValue(499)
param searchResponseReserveMs int = 100
param rootSafetyArbiter bool = true
param rootBranchingReserve bool = false
param opponents array
param provenance object
param replicaTimeout int = 43200

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: jobIdentityName
}

resource job 'Microsoft.App/jobs@2025-07-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: workloadProfileName
    configuration: {
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          identity: identity.id
          server: acr.properties.loginServer
        }
      ]
      replicaRetryLimit: 0
      replicaTimeout: replicaTimeout
      triggerType: 'Manual'
    }
    template: {
      containers: [
        {
          name: jobName
          image: '${acr.properties.loginServer}/${imageRepository}:${imageTag}'
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'JOB_GAMES'
              value: string(games)
            }
            {
              name: 'JOB_LANES'
              value: string(lanes)
            }
            {
              name: 'JOB_GAME_ATTEMPTS'
              value: string(gameAttempts)
            }
            {
              name: 'JOB_BASE_SEED'
              value: string(baseSeed)
            }
            {
              name: 'JOB_GAME_INDEX_OFFSET'
              value: string(gameIndexOffset)
            }
            {
              name: 'JOB_RUN_ID'
              value: runId
            }
            {
              name: 'JOB_SUBJECT_MODEL_VERSION'
              value: subjectModelVersion
            }
            {
              name: 'JOB_OPPONENTS_JSON'
              value: string(opponents)
            }
            {
              name: 'JOB_ZOO_SERVER_BINARY'
              value: '/usr/local/bin/coreyja-zoo'
            }
            {
              name: 'JOB_ZOO_SERVER_PORT'
              value: '8200'
            }
            {
              name: 'JOB_PROVENANCE_JSON'
              value: string(provenance)
            }
            {
              name: 'MODEL_PATH'
              value: modelPath
            }
            {
              name: 'SEARCH_WORKERS'
              value: '4'
            }
            {
              name: 'SEARCH_TIME_BUDGET_MS'
              value: string(searchTimeBudgetMs)
            }
            {
              name: 'SEARCH_RESPONSE_RESERVE_MS'
              value: string(searchResponseReserveMs)
            }
            {
              name: 'SEARCH_FALLBACK_PROTECTION'
              value: 'false'
            }
            {
              name: 'SEARCH_SIMULATE_FOOD_SPAWNS'
              value: 'true'
            }
            {
              name: 'SEARCH_ROLLOUT_POLICY'
              value: 'policy'
            }
            {
              name: 'SEARCH_REUSE_OPPONENT_CONTEXT_TREE'
              value: 'true'
            }
            {
              name: 'SEARCH_TREE_REUSE_CONTEXT_DECAY'
              value: '0.5'
            }
            {
              name: 'SEARCH_STRATEGIC_ROOT_PRIOR'
              value: 'true'
            }
            {
              name: 'SEARCH_ROOT_SAFETY_ARBITER'
              value: rootSafetyArbiter ? 'true' : 'false'
            }
            {
              name: 'SEARCH_ROOT_BRANCHING_RESERVE'
              value: rootBranchingReserve ? 'true' : 'false'
            }
            {
              name: 'JOB_UPLOAD_ENABLED'
              value: 'true'
            }
            {
              name: 'JOB_UPLOAD_CONCURRENCY'
              value: '8'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: 'https://${storage.name}.blob.${az.environment().suffixes.storage}'
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: blobContainerName
            }
            {
              name: 'JOB_STORAGE_PREFIX'
              value: storagePrefix
            }
          ]
          resources: {
            cpu: json('32.0')
            memory: '128Gi'
          }
        }
      ]
    }
  }
}

output name string = job.name
