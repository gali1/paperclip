export * from "./types.js";
export {
  buildDeploymentContext,
  collectReachableHostAddresses,
  detectContainer,
  isLoopbackHost,
  isWildcardBind,
  readDefaultGatewayIpv4,
  resolveHostGatewayCandidates,
} from "./deployment.js";
export { getDiscoveryDescriptor, listDiscoveryDescriptors } from "./catalog.js";
export { probeTcpPort, sanitizeEndpoint } from "./probes.js";
export { createDiscoveryService, type DiscoveryInput, type DiscoveryService, type DiscoveryServiceOptions } from "./service.js";
