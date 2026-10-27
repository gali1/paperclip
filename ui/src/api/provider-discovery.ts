import { api } from "./client";

export type ProviderFindingStatus =
  | "ready"
  | "needs_configuration"
  | "not_reachable"
  | "compatible_unverified"
  | "detected_unverified";

export type ProviderFindingSourceKind =
  | "paperclip_config"
  | "environment"
  | "config_file"
  | "local_service"
  | "container"
  | "generic_endpoint";

export interface ProviderFinding {
  id: string;
  providerId: string;
  label: string;
  category: "hosted" | "local" | "gateway" | "compatible";
  status: ProviderFindingStatus;
  sources: Array<{ kind: ProviderFindingSourceKind; detail: string }>;
  endpoint?: string;
  location: "local" | "host" | "container" | "remote" | "unknown";
  credential: "present" | "missing" | "unknown" | "not_required";
  credentialEnvKeys: string[];
  models: string[];
  requirements: string[];
  warnings: string[];
  confidence: "high" | "medium" | "low";
  setup: {
    providerKey?: string;
    aiConnectionProvider?: string;
    baseUrl?: string;
    defaultModel?: string;
  };
}

export interface ProviderScanStage {
  stage: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  detail?: string;
  found?: number;
}

export interface ProviderScan {
  id: string;
  companyId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  stage: string | null;
  stages: ProviderScanStage[];
  deployment: {
    mode: "native" | "container";
    hostGatewayCandidates: string[];
    loopbackIsProcessLocalOnly: boolean;
    platform: string;
  };
  findings: ProviderFinding[];
  warnings: string[];
  limitations: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

const base = (companyId: string) =>
  `/companies/${encodeURIComponent(companyId)}/provider-discovery`;

export const providerDiscoveryApi = {
  catalog: () => api.get<{ providers: unknown[] }>("/provider-discovery/catalog"),
  start: (companyId: string) => api.post<ProviderScan>(`${base(companyId)}/scans`, {}),
  get: (companyId: string, scanId: string) =>
    api.get<ProviderScan>(`${base(companyId)}/scans/${encodeURIComponent(scanId)}`),
  cancel: (companyId: string, scanId: string) =>
    api.post<ProviderScan>(`${base(companyId)}/scans/${encodeURIComponent(scanId)}/cancel`, {}),
};

export const PROVIDER_STATUS_LABEL: Record<ProviderFindingStatus, string> = {
  ready: "Ready",
  needs_configuration: "Needs configuration",
  compatible_unverified: "Compatible, unverified",
  detected_unverified: "Detected, not validated",
  not_reachable: "Not reachable",
};
