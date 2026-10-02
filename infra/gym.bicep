targetScope = 'resourceGroup'

@description('Deployment-specific resource prefix shared by foundation, gym, and training.')
param resourceNamePrefix string

@description('Azure region for the six isolated gym environments.')
param location string

param acrName string
param storageAccountName string
param logAnalyticsName string = '${resourceNamePrefix}-logs'
param challengerEnvironmentAName string = '${resourceNamePrefix}-gym-challenger-a-${location}'
param challengerEnvironmentBName string = '${resourceNamePrefix}-gym-challenger-b-${location}'
param challengerEnvironmentCName string = '${resourceNamePrefix}-gym-challenger-c-${location}'
param challengerEnvironmentDName string = '${resourceNamePrefix}-gym-challenger-d-${location}'
param legacyEnvironmentAName string = '${resourceNamePrefix}-gym-legacy-a-${location}'
param legacyEnvironmentBName string = '${resourceNamePrefix}-gym-legacy-b-${location}'
param jobWorkloadProfileName string = 'GymD32'
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
param jobIdentityName string = '${resourceNamePrefix}-gym-jobs-identity'
param zooIdentityName string = '${resourceNamePrefix}-zoo-identity'

param jobImageRepository string = 'elaniin-battlesnake'
param jobImageTag string
param zooImageRepository string = 'snake-zoo-coreyja'
param zooImageTag string
param snorkImageRepository string = 'snake-zoo-snork'
param snorkImageTag string
param nessegrevImageRepository string = 'snake-zoo-nessegrev'
param nessegrevImageTag string

@minValue(2)
param gamesPerCohort int = 50

@minValue(1)
@maxValue(15)
param jobsPerEnvironment int = 5

@minValue(1)
param lanesPerJob int = 5

param baseSeed int = 1
param campaignId string
param engineVersion string
param jobImageDigest string
param subjectModelVersion string = 'heuristic-adaptive-control-v1'
param subjectModelSha256 string
param modelPath string = '/app/models/heuristic-adaptive-control-v1.json'
@description('Per-move MCTS budget used by every isolated subject endpoint.')
@minValue(0)
@maxValue(350)
param searchTimeBudgetMs int = 350
@description('Non-search reserve within the Battlesnake game timeout.')
@minValue(0)
@maxValue(499)
param searchResponseReserveMs int = 100
@description('Whether the exact final root-safety arbiter is enabled for the subject engine.')
param rootSafetyArbiter bool = true
@description('Whether the conservative low-slack branching reserve is enabled after hard root safety.')
param rootBranchingReserve bool = false
param smokeMode bool = false
param smokeCampaignId string = '${campaignId}-smoke'

@minValue(1)
param smokeGamesPerJob int = 1

@description('Distance between challenger and legacy seed ranges. Keep the original campaign width for paired subsets.')
@minValue(1)
param cohortSeedStride int = 20000

var jobsPerCohort = jobsPerEnvironment * 2
var challengerLargePoolJobs = (jobsPerEnvironment + 1) / 2
var challengerSmallPoolJobs = jobsPerEnvironment - challengerLargePoolJobs
var activeCampaignId = smokeMode ? smokeCampaignId : campaignId
var smokeBaseSeed = baseSeed + cohortSeedStride * 2
var minimumJobGames = gamesPerCohort / jobsPerCohort
var extraJobGames = gamesPerCohort % jobsPerCohort
var cohortJobs = [for localIndex in range(0, jobsPerCohort): {
  number: localIndex + 1
  games: minimumJobGames + (localIndex < extraJobGames ? 1 : 0)
  gameOffset: localIndex * minimumJobGames + (localIndex < extraJobGames ? localIndex : extraJobGames)
}]
var environmentPlans = [
  {
    name: challengerEnvironmentAName
    deploymentName: 'gym-environment-challenger-a'
    maximumNodeCount: challengerLargePoolJobs
  }
  {
    name: challengerEnvironmentBName
    deploymentName: 'gym-environment-challenger-b'
    maximumNodeCount: challengerLargePoolJobs
  }
  {
    name: challengerEnvironmentCName
    deploymentName: 'gym-environment-challenger-c'
    maximumNodeCount: challengerSmallPoolJobs
  }
  {
    name: challengerEnvironmentDName
    deploymentName: 'gym-environment-challenger-d'
    maximumNodeCount: challengerSmallPoolJobs
  }
  {
    name: legacyEnvironmentAName
    deploymentName: 'gym-environment-legacy-a'
    maximumNodeCount: jobsPerEnvironment
  }
  {
    name: legacyEnvironmentBName
    deploymentName: 'gym-environment-legacy-b'
    maximumNodeCount: jobsPerEnvironment
  }
]

var zooSourceCommit = 'd3a9bed45789f00918ea25df6025ed4e01462ae3'
var challengerOpponentsA = [
  {
    name: 'Hovering-Hobbs'
    url: 'http://127.0.0.1:8200/hovering-hobbs'
  }
  {
    name: 'Snork-Tree'
    url: 'http://${snorkAppAName}'
  }
  {
    name: 'Nessegrev-Expert'
    url: 'http://${nessegrevAppAName}'
  }
]
var challengerOpponentsB = [
  {
    name: 'Hovering-Hobbs'
    url: 'http://127.0.0.1:8200/hovering-hobbs'
  }
  {
    name: 'Snork-Tree'
    url: 'http://${snorkAppBName}'
  }
  {
    name: 'Nessegrev-Expert'
    url: 'http://${nessegrevAppBName}'
  }
]
var challengerOpponentsC = [
  {
    name: 'Hovering-Hobbs'
    url: 'http://127.0.0.1:8200/hovering-hobbs'
  }
  {
    name: 'Snork-Tree'
    url: 'http://${snorkAppCName}'
  }
  {
    name: 'Nessegrev-Expert'
    url: 'http://${nessegrevAppCName}'
  }
]
var challengerOpponentsD = [
  {
    name: 'Hovering-Hobbs'
    url: 'http://127.0.0.1:8200/hovering-hobbs'
  }
  {
    name: 'Snork-Tree'
    url: 'http://${snorkAppDName}'
  }
  {
    name: 'Nessegrev-Expert'
    url: 'http://${nessegrevAppDName}'
  }
]
var legacyOpponents = [
  {
    name: 'Devious-Devin'
    url: 'http://127.0.0.1:8200/devious-devin'
  }
  {
    name: 'Hovering-Hobbs'
    url: 'http://127.0.0.1:8200/hovering-hobbs'
  }
  {
    name: 'Improbable-Irene'
    url: 'http://127.0.0.1:8200/improbable-irene'
  }
]
var challengerProvenance = {
  engineVersion: engineVersion
  subjectModelVersion: subjectModelVersion
  subjectModelSha256: subjectModelSha256
  searchTimeBudgetMs: searchTimeBudgetMs
  searchResponseReserveMs: searchResponseReserveMs
  rootSafetyArbiter: rootSafetyArbiter
  rootBranchingReserve: rootBranchingReserve
  jobImage: '${acrName}.azurecr.io/${jobImageRepository}:${jobImageTag}'
  jobImageDigest: jobImageDigest
  strategicRootPrior: true
  cohort: 'challenger'
  zoo: {
    hobbs: {
      source: 'coreyja/battlesnake-rs'
      commit: zooSourceCommit
      patch: 'infra/zoo/coreyja-hobbs-terminal.patch'
      image: '${acrName}.azurecr.io/${zooImageRepository}:${zooImageTag}'
    }
    snork: {
      source: 'wrenger/snork'
      commit: '76bec0c9c76b31b209fbeb8e409bb3e4c9133eb2'
      agent: 'Tree'
      image: '${acrName}.azurecr.io/${snorkImageRepository}:${snorkImageTag}'
    }
    nessegrev: {
      source: 'nettogrof/nessegrev-java-dev'
      commit: 'ebd1981b66256ff8a8477ed2a2ca0f655df60849'
      agent: 'Expert'
      image: '${acrName}.azurecr.io/${nessegrevImageRepository}:${nessegrevImageTag}'
    }
  }
}
var legacyProvenance = {
  engineVersion: engineVersion
  subjectModelVersion: subjectModelVersion
  subjectModelSha256: subjectModelSha256
  searchTimeBudgetMs: searchTimeBudgetMs
  searchResponseReserveMs: searchResponseReserveMs
  rootSafetyArbiter: rootSafetyArbiter
  rootBranchingReserve: rootBranchingReserve
  jobImage: '${acrName}.azurecr.io/${jobImageRepository}:${jobImageTag}'
  jobImageDigest: jobImageDigest
  strategicRootPrior: true
  cohort: 'legacy'
  zoo: {
    source: 'coreyja/battlesnake-rs'
    commit: zooSourceCommit
    hobbsPatch: 'infra/zoo/coreyja-hobbs-terminal.patch'
    image: '${acrName}.azurecr.io/${zooImageRepository}:${zooImageTag}'
    opponents: [
      'Devious-Devin'
      'Hovering-Hobbs'
      'Improbable-Irene'
    ]
  }
}
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource jobIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: jobIdentityName
  location: location
}

resource zooIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: zooIdentityName
  location: location
}

resource zooAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, zooIdentity.id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    principalId: zooIdentity.properties.principalId
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

resource jobBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, jobIdentity.id, storageBlobDataContributorRoleDefinitionId)
  scope: storage
  properties: {
    principalId: jobIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

module environments './gym-environment.bicep' = [for environmentPlan in environmentPlans: {
  name: environmentPlan.deploymentName
  params: {
    location: location
    environmentName: environmentPlan.name
    logAnalyticsName: logAnalyticsName
    workloadProfileName: jobWorkloadProfileName
    maximumNodeCount: environmentPlan.maximumNodeCount
  }
}]

module snorkZooA './zoo-app.bicep' = {
  name: 'zoo-snork-a'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[0].outputs.name
    identityName: zooIdentity.name
    appName: snorkAppAName
    containerName: 'snake-zoo-snork-a'
    imageRepository: snorkImageRepository
    imageTag: snorkImageTag
    targetPort: 8300
    environmentVariables: [
      {
        name: 'RUST_LOG'
        value: 'error'
      }
    ]
    concurrentRequests: 1
    minReplicas: challengerLargePoolJobs * lanesPerJob
    maxReplicas: challengerLargePoolJobs * lanesPerJob
  }
  dependsOn: [zooAcrPull]
}

module snorkZooB './zoo-app.bicep' = {
  name: 'zoo-snork-b'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[1].outputs.name
    identityName: zooIdentity.name
    appName: snorkAppBName
    containerName: 'snake-zoo-snork-b'
    imageRepository: snorkImageRepository
    imageTag: snorkImageTag
    targetPort: 8300
    environmentVariables: [
      {
        name: 'RUST_LOG'
        value: 'error'
      }
    ]
    concurrentRequests: 1
    minReplicas: challengerLargePoolJobs * lanesPerJob
    maxReplicas: challengerLargePoolJobs * lanesPerJob
  }
  dependsOn: [zooAcrPull]
}

module snorkZooC './zoo-app.bicep' = {
  name: 'zoo-snork-c'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[2].outputs.name
    identityName: zooIdentity.name
    appName: snorkAppCName
    containerName: 'snake-zoo-snork-c'
    imageRepository: snorkImageRepository
    imageTag: snorkImageTag
    targetPort: 8300
    environmentVariables: [
      {
        name: 'RUST_LOG'
        value: 'error'
      }
    ]
    concurrentRequests: 1
    minReplicas: challengerSmallPoolJobs * lanesPerJob
    maxReplicas: challengerSmallPoolJobs * lanesPerJob
  }
  dependsOn: [zooAcrPull]
}

module snorkZooD './zoo-app.bicep' = {
  name: 'zoo-snork-d'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[3].outputs.name
    identityName: zooIdentity.name
    appName: snorkAppDName
    containerName: 'snake-zoo-snork-d'
    imageRepository: snorkImageRepository
    imageTag: snorkImageTag
    targetPort: 8300
    environmentVariables: [
      {
        name: 'RUST_LOG'
        value: 'error'
      }
    ]
    concurrentRequests: 1
    minReplicas: challengerSmallPoolJobs * lanesPerJob
    maxReplicas: challengerSmallPoolJobs * lanesPerJob
  }
  dependsOn: [zooAcrPull]
}

module nessegrevZooA './zoo-app.bicep' = {
  name: 'zoo-nessegrev-a'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[0].outputs.name
    identityName: zooIdentity.name
    appName: nessegrevAppAName
    containerName: 'snake-zoo-nessegrev-a'
    imageRepository: nessegrevImageRepository
    imageTag: nessegrevImageTag
    targetPort: 8400
    concurrentRequests: 2
    minReplicas: (challengerLargePoolJobs * lanesPerJob + 1) / 2
    maxReplicas: (challengerLargePoolJobs * lanesPerJob + 1) / 2
  }
  dependsOn: [zooAcrPull]
}

module nessegrevZooB './zoo-app.bicep' = {
  name: 'zoo-nessegrev-b'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[1].outputs.name
    identityName: zooIdentity.name
    appName: nessegrevAppBName
    containerName: 'snake-zoo-nessegrev-b'
    imageRepository: nessegrevImageRepository
    imageTag: nessegrevImageTag
    targetPort: 8400
    concurrentRequests: 2
    minReplicas: (challengerLargePoolJobs * lanesPerJob + 1) / 2
    maxReplicas: (challengerLargePoolJobs * lanesPerJob + 1) / 2
  }
  dependsOn: [zooAcrPull]
}

module nessegrevZooC './zoo-app.bicep' = {
  name: 'zoo-nessegrev-c'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[2].outputs.name
    identityName: zooIdentity.name
    appName: nessegrevAppCName
    containerName: 'snake-zoo-nessegrev-c'
    imageRepository: nessegrevImageRepository
    imageTag: nessegrevImageTag
    targetPort: 8400
    concurrentRequests: 2
    minReplicas: (challengerSmallPoolJobs * lanesPerJob + 1) / 2
    maxReplicas: (challengerSmallPoolJobs * lanesPerJob + 1) / 2
  }
  dependsOn: [zooAcrPull]
}

module nessegrevZooD './zoo-app.bicep' = {
  name: 'zoo-nessegrev-d'
  params: {
    location: location
    acrName: acr.name
    environmentName: environments[3].outputs.name
    identityName: zooIdentity.name
    appName: nessegrevAppDName
    containerName: 'snake-zoo-nessegrev-d'
    imageRepository: nessegrevImageRepository
    imageTag: nessegrevImageTag
    targetPort: 8400
    concurrentRequests: 2
    minReplicas: (challengerSmallPoolJobs * lanesPerJob + 1) / 2
    maxReplicas: (challengerSmallPoolJobs * lanesPerJob + 1) / 2
  }
  dependsOn: [zooAcrPull]
}

module challengerJobsA './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number <= challengerLargePoolJobs) {
  name: 'gym-challenger-a-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[0].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${challengerJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-challenger-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/challenger/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: challengerOpponentsA
    provenance: union(challengerProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'challenger-a'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor, snorkZooA, nessegrevZooA]
}]

module challengerJobsB './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number > jobsPerEnvironment && jobPlan.number <= jobsPerEnvironment + challengerLargePoolJobs) {
  name: 'gym-challenger-b-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[1].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${challengerJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-challenger-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/challenger/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: challengerOpponentsB
    provenance: union(challengerProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'challenger-b'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor, snorkZooB, nessegrevZooB]
}]

module challengerJobsC './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number > challengerLargePoolJobs && jobPlan.number <= jobsPerEnvironment) {
  name: 'gym-challenger-c-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[2].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${challengerJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-challenger-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/challenger/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: challengerOpponentsC
    provenance: union(challengerProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'challenger-c'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor, snorkZooC, nessegrevZooC]
}]

module challengerJobsD './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number > jobsPerEnvironment + challengerLargePoolJobs) {
  name: 'gym-challenger-d-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[3].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${challengerJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-challenger-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/challenger/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: challengerOpponentsD
    provenance: union(challengerProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'challenger-d'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor, snorkZooD, nessegrevZooD]
}]

module legacyJobsA './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number <= jobsPerEnvironment) {
  name: 'gym-legacy-a-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[4].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${legacyJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + jobsPerCohort * smokeGamesPerJob + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + cohortSeedStride + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-legacy-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/legacy/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: legacyOpponents
    provenance: union(legacyProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'legacy-a'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor]
}]

module legacyJobsB './gym-job.bicep' = [for jobPlan in cohortJobs: if (jobPlan.number > jobsPerEnvironment) {
  name: 'gym-legacy-b-job-${jobPlan.number}'
  params: {
    location: location
    acrName: acr.name
    storageAccountName: storage.name
    environmentName: environments[5].outputs.name
    workloadProfileName: jobWorkloadProfileName
    jobIdentityName: jobIdentity.name
    jobName: '${legacyJobNamePrefix}-${jobPlan.number}'
    imageRepository: jobImageRepository
    imageTag: jobImageTag
    blobContainerName: blobContainerName
    games: smokeMode ? smokeGamesPerJob : jobPlan.games
    lanes: jobPlan.games < lanesPerJob ? jobPlan.games : lanesPerJob
    baseSeed: smokeMode ? smokeBaseSeed + jobsPerCohort * smokeGamesPerJob + (jobPlan.number - 1) * smokeGamesPerJob : baseSeed + cohortSeedStride + jobPlan.gameOffset
    gameIndexOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
    runId: '${activeCampaignId}-legacy-shard-${jobPlan.number}'
    storagePrefix: 'telemetry/raw/gym/${activeCampaignId}/legacy/shard-${jobPlan.number}'
    subjectModelVersion: subjectModelVersion
    modelPath: modelPath
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
    rootSafetyArbiter: rootSafetyArbiter
    rootBranchingReserve: rootBranchingReserve
    opponents: legacyOpponents
    provenance: union(legacyProvenance, {
      campaignId: activeCampaignId
      plannedCampaignId: campaignId
      mode: smokeMode ? 'smoke' : 'campaign'
      computePool: 'legacy-b'
      shard: {
        number: jobPlan.number
        count: jobsPerCohort
        games: smokeMode ? smokeGamesPerJob : jobPlan.games
        gameOffset: smokeMode ? (jobPlan.number - 1) * smokeGamesPerJob : jobPlan.gameOffset
      }
    })
  }
  dependsOn: [jobAcrPull, jobBlobContributor]
}]

output snorkFqdn string = snorkZooA.outputs.fqdn
output nessegrevFqdn string = nessegrevZooA.outputs.fqdn
output snorkFqdns array = [snorkZooA.outputs.fqdn, snorkZooB.outputs.fqdn, snorkZooC.outputs.fqdn, snorkZooD.outputs.fqdn]
output nessegrevFqdns array = [nessegrevZooA.outputs.fqdn, nessegrevZooB.outputs.fqdn, nessegrevZooC.outputs.fqdn, nessegrevZooD.outputs.fqdn]
output environmentNames array = [for index in range(0, 6): environments[index].outputs.name]
output challengerJobNames array = [for index in range(0, jobsPerCohort): '${challengerJobNamePrefix}-${index + 1}']
output legacyJobNames array = [for index in range(0, jobsPerCohort): '${legacyJobNamePrefix}-${index + 1}']
output campaign object = {
  id: activeCampaignId
  plannedCampaignId: campaignId
  mode: smokeMode ? 'smoke' : 'campaign'
  gamesPerCohort: smokeMode ? jobsPerCohort * smokeGamesPerJob : gamesPerCohort
  totalGames: smokeMode ? jobsPerCohort * smokeGamesPerJob * 2 : gamesPerCohort * 2
  jobsPerEnvironment: jobsPerEnvironment
  challengerJobsByEnvironment: [challengerLargePoolJobs, challengerLargePoolJobs, challengerSmallPoolJobs, challengerSmallPoolJobs]
  legacyJobsByEnvironment: [jobsPerEnvironment, jobsPerEnvironment]
  jobsPerCohort: jobsPerCohort
  totalJobs: jobsPerCohort * 2
  lanesPerJob: lanesPerJob
  concurrentGames: gamesPerCohort * 2 < jobsPerCohort * lanesPerJob * 2
    ? gamesPerCohort * 2
    : jobsPerCohort * lanesPerJob * 2
  searchTimeBudgetMs: searchTimeBudgetMs
  searchResponseReserveMs: searchResponseReserveMs
  rootSafetyArbiter: rootSafetyArbiter
  rootBranchingReserve: rootBranchingReserve
  challengerBaseSeed: smokeMode ? smokeBaseSeed : baseSeed
  legacyBaseSeed: smokeMode ? smokeBaseSeed + jobsPerCohort * smokeGamesPerJob : baseSeed + cohortSeedStride
}
