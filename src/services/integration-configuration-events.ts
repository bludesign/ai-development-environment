import {
  agentEventBus,
  INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
} from "@/services/agent-control";

export function publishIntegrationConfiguration(provider: string) {
  agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
    integrationConfigurationChanged: provider,
  });
}

/** Publish after successful configuration writes, preserving resolver arguments and authorization. */
export function withIntegrationConfigurationEvents<
  T extends { Mutation: object },
>(resolvers: T, provider: string, fields: Array<keyof T["Mutation"]>): T {
  const mutations = { ...resolvers.Mutation } as T["Mutation"];
  for (const field of fields) {
    const original = mutations[field] as (...args: never[]) => unknown;
    mutations[field] = ((...args: never[]) => {
      const result = original(...args);
      return Promise.resolve(result).then((value) => {
        publishIntegrationConfiguration(provider);
        return value;
      });
    }) as T["Mutation"][typeof field];
  }
  return { ...resolvers, Mutation: mutations };
}
