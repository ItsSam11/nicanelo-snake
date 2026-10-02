targetScope = 'subscription'

@description('Deployment-specific resource prefix. Keep its value outside the repository.')
param resourceNamePrefix string

@description('Azure region for every regional resource.')
param location string = 'eastus2'

@description('Resource group that contains the Battlesnake stack.')
param resourceGroupName string

@description('Create the Container App and manual tournament Job after their images exist in ACR.')
param deployCompute bool = false

@description('Create Azure Managed Redis. Can be disabled when the region has no small-SKU capacity.')
param deployRedis bool = true

@description('Globally unique Azure Container Registry name.')
param acrName string

@description('Globally unique Storage account name.')
param storageAccountName string

@description('Globally unique Azure Managed Redis name.')
param redisName string

@description('Azure Managed Redis SKU. Balanced_B0 exactly matches West US 2.')
param redisSku string = 'Balanced_B0'

@description('Immutable application image promoted to the public Battlesnake endpoint.')
param appImageTag string

@description('Verified image tags and provenance for the isolated evaluation Jobs.')
param jobImageTag string
param zooImageTag string
param snorkImageTag string
param nessegrevImageTag string
param gymCampaignId string
param gymEngineVersion string
param gymJobImageDigest string
param gymSubjectModelSha256 string

@description('Immutable strategy artifact loaded by the public Battlesnake endpoint.')
param appModelPath string = '/app/models/heuristic-adaptive-control-v1.json'

@description('Strategy model version recorded by the public Battlesnake endpoint.')
param appModelVersion string = 'heuristic-adaptive-control-v1'

param appPublicVersion string = 'development'

@description('Per-move MCTS budget for the public app and isolated gym jobs.')
@minValue(0)
@maxValue(350)
param searchTimeBudgetMs int = 350

@description('Non-search reserve within the Battlesnake game timeout.')
@minValue(0)
@maxValue(499)
param searchResponseReserveMs int = 100

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

module stack './stack.bicep' = {
  name: 'battlesnake-${uniqueString(resourceGroup.id)}'
  scope: resourceGroup
  params: {
    location: location
    resourceNamePrefix: resourceNamePrefix
    deployCompute: deployCompute
    deployRedis: deployRedis
    acrName: acrName
    storageAccountName: storageAccountName
    redisName: redisName
    redisSku: redisSku
    appImageTag: appImageTag
    jobImageTag: jobImageTag
    zooImageTag: zooImageTag
    snorkImageTag: snorkImageTag
    nessegrevImageTag: nessegrevImageTag
    gymCampaignId: gymCampaignId
    gymEngineVersion: gymEngineVersion
    gymJobImageDigest: gymJobImageDigest
    gymSubjectModelSha256: gymSubjectModelSha256
    appModelPath: appModelPath
    appModelVersion: appModelVersion
    appPublicVersion: appPublicVersion
    searchTimeBudgetMs: searchTimeBudgetMs
    searchResponseReserveMs: searchResponseReserveMs
  }
}

output resourceGroupName string = resourceGroup.name
output acrName string = stack.outputs.acrName
output acrLoginServer string = stack.outputs.acrLoginServer
output storageAccountName string = stack.outputs.storageAccountName
output redisHostName string = stack.outputs.redisHostName
output appFqdn string = stack.outputs.appFqdn
output snorkFqdn string = stack.outputs.snorkFqdn
output nessegrevFqdn string = stack.outputs.nessegrevFqdn
