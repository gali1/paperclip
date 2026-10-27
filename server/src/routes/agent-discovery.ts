/**
 * Agent discovery and connectivity diagnostics routes.
 *
 * These routes are read-only with respect to configuration: they probe the
 * environment, report what is reachable from this Paperclip process, and let the
 * UI apply a `configPatch` through the existing agent create/update routes.
 *
 * - GET  /companies/:companyId/adapters/discovery/deployment
 * - POST /companies/:companyId/adapters/:type/discover
 *
 * Both require company write access because the answer exposes host topology and
 * because the discovery result is used to create or reconfigure agents.
 *
 * @module server/routes/agent-discovery
 */

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agents as agentsTable, type Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { findServerAdapter, getServerAdapter } from "../adapters/registry.js";
import { assertCompanyAccess, assertBoardOrgAccess } from "./authz.js";
import {
  createDiscoveryService,
  listDiscoveryDescriptors,
  type DiscoveryService,
} from "../services/agent-discovery/index.js";

const discoverSchema = z
  .object({
    remoteEndpoints: z.array(z.string().trim().min(1)).max(8).optional(),
    configOverrides: z.record(z.string(), z.unknown()).optional(),
    includeContainers: z.boolean().optional(),
    validate: z.boolean().optional(),
    refresh: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .strict()
  // An empty POST is a valid "discover with defaults" request.
  .default({});

export interface AgentDiscoveryRouteOptions {
  db: Db;
  deployment: {
    bindHost: string;
    port: number;
    publicUrl?: string;
    deploymentMode?: string;
    deploymentExposure?: string;
  };
  /** Test seam. */
  service?: DiscoveryService;
}

export function agentDiscoveryRoutes(options: AgentDiscoveryRouteOptions) {
  const router = Router();
  const service =
    options.service ??
    createDiscoveryService({
      deployment: options.deployment,
      deps: {
        listRegisteredAgents: async (companyId, adapterType) => {
          const rows = await options.db
            .select({
              id: agentsTable.id,
              name: agentsTable.name,
              adapterConfig: agentsTable.adapterConfig,
              status: agentsTable.status,
              lastHeartbeatAt: agentsTable.lastHeartbeatAt,
            })
            .from(agentsTable)
            .where(
              and(
                eq(agentsTable.companyId, companyId),
                eq(agentsTable.adapterType, adapterType),
                inArray(agentsTable.status, ["idle", "running", "error", "paused"]),
              ),
            )
            .limit(20);
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            adapterConfig: (row.adapterConfig ?? {}) as Record<string, unknown>,
            status: row.status,
            lastHeartbeatAt: row.lastHeartbeatAt,
          }));
        },
        testEnvironment: async (adapterType, config) => {
          const adapter = getServerAdapter(adapterType);
          if (!adapter) return null;
          const result = await adapter.testEnvironment({
            companyId: "",
            adapterType,
            config,
            deployment: {
              mode: options.deployment.deploymentMode as "local_trusted" | "authenticated" | undefined,
              exposure: options.deployment.deploymentExposure as "private" | "public" | undefined,
              bindHost: options.deployment.bindHost,
            },
          });
          return {
            status: result.status,
            checks: result.checks.map((check) => ({
              code: check.code,
              level: check.level,
              message: check.message,
            })),
          };
        },
      },
    });

  /** Static hints so a client can render "what we look for" before probing. */
  router.get("/adapters/discovery/catalog", (req, res) => {
    assertBoardOrgAccess(req);
    res.json(
      listDiscoveryDescriptors().map((descriptor) => ({
        adapterType: descriptor.adapterType,
        label: descriptor.label,
        transport: descriptor.transport,
        commands: descriptor.commands,
        localServices: descriptor.localServices ?? [],
        capabilities: descriptor.capabilities ?? [],
        installHint: descriptor.installHint ?? null,
      })),
    );
  });

  /**
   * Deployment context + optional host reachability probe.
   *
   * `probePort` answers "if my agent listens on this host port, which host
   * aliases can Paperclip actually reach it on?" — the exact question that
   * container-to-host setups get wrong.
   */
  router.get("/companies/:companyId/adapters/discovery/deployment", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);

    const deployment = service.deploymentContext();
    const probePortRaw = typeof req.query.probePort === "string" ? req.query.probePort.trim() : "";
    const probePort = probePortRaw ? Number(probePortRaw) : null;
    const connectivity =
      probePort && Number.isInteger(probePort) && probePort > 0 && probePort <= 65_535
        ? await service.probeConnectivity(probePort)
        : null;

    res.json({
      ...deployment,
      ...(connectivity ? { connectivity } : {}),
      hints: buildHints(deployment),
    });
  });

  /** Full discovery sweep for one adapter type. */
  router.post(
    "/companies/:companyId/adapters/:type/discover",
    validate(discoverSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const adapterType = req.params.type as string;
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, companyId);

      // findServerAdapter (not getServerAdapter) so an unknown type is a 404
      // instead of silently falling back to the generic process adapter.
      if (!findServerAdapter(adapterType)) throw notFound(`Unknown adapter type: ${adapterType}`);

      const startedAt = Date.now();
      const report = await service.discover({
        companyId,
        adapterType,
        remoteEndpoints: req.body.remoteEndpoints,
        configOverrides: req.body.configOverrides,
        includeContainers: req.body.includeContainers,
        validate: req.body.validate,
        refresh: req.body.refresh,
        timeoutMs: req.body.timeoutMs,
      });

      logger.info(
        {
          companyId,
          adapterType,
          candidates: report.candidates.length,
          validated: report.candidates.filter((candidate) => candidate.validated).length,
          durationMs: Date.now() - startedAt,
          deploymentMode: report.deployment.mode,
        },
        "agent discovery completed",
      );

      res.json({
        ...report,
        recommendedCandidateId:
          report.candidates.find((candidate) => candidate.validated && candidate.reachable)?.id ??
          report.candidates.find((candidate) => candidate.reachable)?.id ??
          null,
      });
    },
  );

  return router;
}

function buildHints(deployment: ReturnType<DiscoveryService["deploymentContext"]>): string[] {
  if (deployment.mode === "native") {
    return [
      "Agents installed on this host are probed directly; loopback endpoints mean this machine.",
      "Containerized agents are reachable through their published host ports on 127.0.0.1.",
    ];
  }
  return [
    "Loopback inside this container is the container itself, not the Docker host.",
    deployment.hostGatewayCandidates.length
      ? `Host-native agents must listen on 0.0.0.0; reach them via ${deployment.hostGatewayCandidates.join(" or ")}.`
      : "No host gateway alias is available; add extra_hosts: [\"host.docker.internal:host-gateway\"] to the Compose service.",
    "Agents in other containers are reachable by Compose service name or published host port.",
  ];
}
