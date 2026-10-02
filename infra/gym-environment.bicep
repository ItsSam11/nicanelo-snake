targetScope = 'resourceGroup'

param location string
param environmentName string
param logAnalyticsName string
param workloadProfileName string

@minValue(1)
@maxValue(15)
param maximumNodeCount int

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-07-01' existing = {
  name: logAnalyticsName
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
        name: workloadProfileName
        workloadProfileType: 'D32'
        minimumCount: 0
        maximumCount: maximumNodeCount
      }
    ]
    zoneRedundant: false
  }
}

output name string = environment.name
