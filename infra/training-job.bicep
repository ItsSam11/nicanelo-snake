targetScope = 'resourceGroup'

param location string
param acrName string
param environmentName string
param workloadProfileName string
param jobIdentityName string
param jobName string
param imageRepository string
param imageTag string
param command array
param args array = []
param environmentVariables array
param replicaTimeout int = 43200

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
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
          command: command
          args: args
          env: concat([
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
          ], environmentVariables)
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
