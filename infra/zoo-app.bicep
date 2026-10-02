targetScope = 'resourceGroup'

param location string
param acrName string
param environmentName string
param identityName string
param appName string
param containerName string
param imageRepository string
param imageTag string
param targetPort int
param environmentVariables array = []
param cpu int = 4
param memory string = '8Gi'
param minReplicas int = 1
param maxReplicas int = 40
param concurrentRequests int = 2

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: true
        external: false
        targetPort: targetPort
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
          identity: identity.id
          server: acr.properties.loginServer
        }
      ]
    }
    template: {
      containers: [
        {
          name: containerName
          image: '${acr.properties.loginServer}/${imageRepository}:${imageTag}'
          env: environmentVariables
          resources: {
            cpu: cpu
            memory: memory
          }
        }
      ]
      scale: {
        cooldownPeriod: 300
        maxReplicas: maxReplicas
        minReplicas: minReplicas
        pollingInterval: 15
        rules: [
          {
            name: 'http-scaler'
            http: {
              metadata: {
                concurrentRequests: string(concurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
