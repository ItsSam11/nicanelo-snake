targetScope = 'resourceGroup'

@description('Deployment-specific resource prefix shared by foundation, gym, and training.')
param resourceNamePrefix string

@description('Azure region for all resources.')
param location string

@description('Create the Container App and manual tournament Job.')
param deployCompute bool

@description('Create and connect Azure Managed Redis.')
param deployRedis bool

param acrName string
param storageAccountName string
param redisName string
param redisSku string

param logAnalyticsName string = '${resourceNamePrefix}-logs'
param environmentName string = '${resourceNamePrefix}-service-env'
param challengerGymEnvironmentAName string = '${resourceNamePrefix}-gym-challenger-a-${location}'
param challengerGymEnvironmentBName string = '${resourceNamePrefix}-gym-challenger-b-${location}'
param challengerGymEnvironmentCName string = '${resourceNamePrefix}-gym-challenger-c-${location}'
param challengerGymEnvironmentDName string = '${resourceNamePrefix}-gym-challenger-d-${location}'
param legacyGymEnvironmentAName string = '${resourceNamePrefix}-gym-legacy-a-${location}'
param legacyGymEnvironmentBName string = '${resourceNamePrefix}-gym-legacy-b-${location}'
param gymWorkloadProfileName string = 'GymD32'
param appName string = '${resourceNamePrefix}-service'
param challengerJobNamePrefix string = '${resourceNamePrefix}-gym-challenger'
param legacyJobNamePrefix string = '${resourceNamePrefix}-gym-legacy'
param snorkAppAName string = '${resourceNamePrefix}-zoo-snork-a'
param snorkAppBName string = '${resourceNamePrefix}-zoo-snork-b'
param snorkAppCName string = '${resourceNamePrefix}-zoo-snork-c'
param snorkAppDName string = '${resourceNamePrefix}-zoo-snork-d'
param nessegrevAppAName string = '${resourceNamePrefix}-zoo-nessegrev-a'
param nessegrevAppBName string = '${resourceNamePrefix}-zoo-nessegrev-b'
param nessegrevAppCName string = '${resourceNamePrefix}-zoo-nessegrev-c'
param nessegrevAppDName string = '${resourceNamePrefix}-zoo-nessegrev-d'
param blobContainerName string = 'battlesnake-corpus'
param appIdentityName string = '${resourceNamePrefix}-service-identity'
param jobIdentityName string = '${resourceNamePrefix}-batch-identity'
param gymJobIdentityName string = '${resourceNamePrefix}-gym-jobs-identity'
param gymZooIdentityName string = '${resourceNamePrefix}-zoo-identity'

param appImageRepository string = 'elaniin-battlesnake'
param appImageTag string
param appModelPath string = '/app/models/heuristic-adaptive-control-v1.json'
param appModelVersion string = 'heuristic-adaptive-control-v1'
param appPublicVersion string = 'development'
@description('Per-move MCTS budget shared by the public app and isolated gym jobs.')
@minValue(0)
@maxValue(350)
param searchTimeBudgetMs int = 350

@description('Time kept outside MCTS for request parsing, aggregation, and response delivery.')
@minValue(0)
@maxValue(499)
param searchResponseReserveMs int = 100
param jobImageRepository string = 'elaniin-battlesnake'
param jobImageTag string
param zooImageRepository string = 'snake-zoo-coreyja'
param zooImageTag string
param snorkImageRepository string = 'snake-zoo-snork'
param snorkImageTag string
param nessegrevImageRepository string = 'snake-zoo-nessegrev'
param nessegrevImageTag string

param gymGamesPerCohort int = 20000
param gymJobsPerEnvironment int = 15
param gymLanesPerJob int = 5
param gymBaseSeed int = 1
param gymCampaignId string
param gymEngineVersion string
param gymJobImageDigest string
param gymSubjectModelSha256 string

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    retentionInDays: 30
  }
  #disable-next-line BCP187 // Azure accepts workspace.sku; current Bicep types omit it.
  sku: {
    name: 'PerGB2018'
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    networkRuleBypassOptions: 'AzureServices'
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource corpusContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: blobContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: appIdentityName
  location: location
}

resource jobIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: jobIdentityName
  location: location
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, appIdentity.id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource jobAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, jobIdentity.id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    principalId: jobIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource appBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appIdentity.id, storageBlobDataContributorRoleDefinitionId)
  scope: storage
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource jobBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, jobIdentity.id, storageBlobDataContributorRoleDefinitionId)
  scope: storage
  properties: {
    principalId: jobIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource redis 'Microsoft.Cache/redisEnterprise@2025-07-01' = if (deployRedis) {
  name: redisName
  location: location
  sku: {
    name: redisSku
  }
  properties: {
    encryption: {}
    highAvailability: 'Disabled'
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = if (deployRedis) {
  parent: redis
  name: 'default'
  properties: {
    accessKeysAuthentication: 'Disabled'
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'OSSCluster'
    evictionPolicy: 'VolatileTTL'
    modules: []
    port: 10000
  }
}

resource redisAppAccess 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2025-07-01' = if (deployRedis) {
  parent: redisDatabase
  name: 'battlesnakecontainerapp'
  properties: {
    accessPolicyName: 'default'
    user: {
      objectId: appIdentity.properties.principalId
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    publicNetworkAccess: 'Enabled'
    workloadProfiles: [
      {
        name: 'Flex'
        workloadProfileType: 'Flex'
      }
    ]
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2025-07-01' = if (deployCompute) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Flex'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'auto'
      }
      registries: [
        {
          identity: appIdentity.id
          server: acr.properties.loginServer
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: '${acr.properties.loginServer}/${appImageRepository}:${appImageTag}'
          env: [
            {
              name: 'SNAKE_AUTHOR'
              value: 'cesar'
            }
            {
              name: 'SNAKE_VERSION'
              value: appPublicVersion
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: appIdentity.properties.clientId
            }
            {
              name: 'REDIS_ENABLED'
              value: string(deployRedis)
            }
            {
              name: 'REDIS_ENDPOINT'
              value: deployRedis ? '${redis!.properties.hostName}:10000' : ''
            }
            {
              name: 'REDIS_KEY_PREFIX'
              value: 'battlesnake'
            }
            {
              name: 'REDIS_TTL_SECONDS'
              value: '1800'
            }
            {
              name: 'REDIS_CONNECT_TIMEOUT_MS'
              value: '1500'
            }
            {
              name: 'AZURE_BLOB_ENABLED'
              value: 'true'
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
              name: 'AZURE_STORAGE_PREFIX'
              value: 'telemetry/raw/live'
            }
            {
              name: 'PERSISTENCE_QUEUE_CAPACITY'
              value: '512'
            }
            {
              name: 'PERSISTENCE_FLUSH_TIMEOUT_MS'
              value: '5000'
            }
            {
              name: 'MODEL_PATH'
              value: appModelPath
            }
            {
              name: 'MODEL_VERSION'
              value: appModelVersion
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
              name: 'SEARCH_STRATEGIC_ROOT_PRIOR'
              value: 'true'
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
          ]
          resources: {
            cpu: json('32.0')
            memory: '128Gi'
          }
        }
      ]
      scale: {
        // Search trees, opponent observations, and tactical state are
        // intentionally process-local and partitioned by game.id. A single
        // replica preserves that continuity without synchronous network I/O
        // on /move; horizontal scale needs an explicit game-aware router.
        cooldownPeriod: 300
        maxReplicas: 1
        minReplicas: 1
        pollingInterval: 30
        rules: [
          {
            name: 'http-scaler'
            http: {
              metadata: {
                concurrentRequests: '1'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    appAcrPull
    appBlobContributor
    redisAppAccess
  ]
}

module gym 'gym.bicep' = if (deployCompute) {
  name: 'gym-zoo'
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    acrName: acr.name
    storageAccountName: storage.name
    logAnalyticsName: logAnalytics.name
    challengerEnvironmentAName: challengerGymEnvironmentAName
    challengerEnvironmentBName: challengerGymEnvironmentBName
    challengerEnvironmentCName: challengerGymEnvironmentCName
    challengerEnvironmentDName: challengerGymEnvironmentDName
    legacyEnvironmentAName: legacyGymEnvironmentAName
    legacyEnvironmentBName: legacyGymEnvironmentBName
    jobWorkloadProfileName: gymWorkloadProfileName
    challengerJobNamePrefix: challengerJobNamePrefix
    legacyJobNamePrefix: legacyJobNamePrefix
    snorkAppAName: snorkAppAName
    snorkAppBName: snorkAppBName
    snorkAppCName: snorkAppCName
    snorkAppDName: snorkAppDName
    nessegrevAppAName: nessegrevAppAName
    nessegrevAppBName: nessegrevAppBName
    nessegrevAppCName: nessegrevAppCName
    nessegrevAppDName: nessegrevAppDName
    blobContainerName: blobContainerName
    jobIdentityName: gymJobIdentityName
    zooIdentityName: gymZooIdentityName
    jobImageRepository: jobImageRepository
    jobImageTag: jobImageTag
    zooImageRepository: zooImageRepository
    zooImageTag: zooImageTag
    snorkImageRepository: snorkImageRepository
    snorkImageTag: snorkImageTag
    nessegrevImageRepository: nessegrevImageRepository
    nessegrevImageTag: nessegrevImageTag
    gamesPerCohort: gymGamesPerCohort
    jobsPerEnvironment: gymJobsPerEnvironment
    lanesPerJob: gymLanesPerJob
    baseSeed: gymBaseSeed
    campaignId: gymCampaignId
    engineVersion: gymEngineVersion
    jobImageDigest: gymJobImageDigest
    subjectModelSha256: gymSubjectModelSha256
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
  }
  dependsOn: [
    jobAcrPull
    jobBlobContributor
  ]
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output storageAccountName string = storage.name
output redisHostName string = deployRedis ? redis!.properties.hostName : ''
output appFqdn string = deployCompute ? app!.properties.configuration.ingress.fqdn : ''
output snorkFqdn string = deployCompute ? gym!.outputs.snorkFqdn : ''
output nessegrevFqdn string = deployCompute ? gym!.outputs.nessegrevFqdn : ''
