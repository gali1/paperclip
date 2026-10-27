/**
 * AUTO provider discovery routes.
 *
 * A scan is a short-lived, in-memory, company-scoped job. The client starts it,
 * polls for the stage-by-stage snapshot, and may cancel it. Results are
 * advisory: adopting a provider still goes through the existing agent/connection
 * flow and its credential handling.
 *
 * - GET  /companies/:companyId/provider-discovery/catalog
 * - POST /companies/:companyId/provider-discovery/scans
 * - GET  /companies/:companyId/provider-discovery/scans/:scanId
 * - POST /companies/:companyId/provider-discovery/scans/:scanId/cancel
 *
 * @module server/routes/provider-discovery
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { agents as agentsTable, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { assertBoardOrgAccess, assertCompanyAccess } from "./authz.js";
import {
  createProviderDiscoveryService,
  listDiscoverableProviders,
  type ProviderDiscoveryService,
} from "../services/provider-discovery/index.js";

export interface ProviderDiscoveryRouteOptions {
  db: Db;
  deployment: {
    bindHost: string;
    port: number;
    publicUrl?: string;
    deploymentMode?: string;
    deploymentExposure?: string;
  };
  /** Test seam. */
  service?: ProviderDiscoveryService;
}

export function providerDiscoveryRoutes(options: ProviderDiscoveryRouteOptions) {
  const router = Router();
  const service =
    options.service ??
    createProviderDiscoveryService({
      deployment: options.deployment,
      deps: {
        listConfiguredEnvKeys: async (companyId) => {
          const rows = await options.db
            .select({ adapterConfig: agentsTable.adapterConfig })
            .from(agentsTable)
            .where(eq(agentsTable.companyId, companyId))
            .limit(200);
          const keys = new Set<string>();
          for (const row of rows) {
            const config = row.adapterConfig as Record<string, unknown> | null;
            const env = config?.env;
            if (!env || typeof env !== "object" || Array.isArray(env)) continue;
            for (const key of Object.keys(env as Record<string, unknown>)) {
              if (/^[A-Z0-9_]+$/.test(key)) keys.add(key);
            }
          }
          return [...keys];
        },
      },
    });

  router.get("/provider-discovery/catalog", (req, res) => {
    assertBoardOrgAccess(req);
    res.json({ providers: listDiscoverableProviders() });
  });

  router.post("/companies/:companyId/provider-discovery/scans", (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
    res.status(202).json(service.start(companyId));
  });

  router.get("/companies/:companyId/provider-discovery/scans/:scanId", (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
    const snapshot = service.get(companyId, req.params.scanId as string);
    if (!snapshot) throw notFound("Discovery scan not found");
    res.json(snapshot);
  });

  router.post("/companies/:companyId/provider-discovery/scans/:scanId/cancel", (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, companyId);
    const snapshot = service.cancel(companyId, req.params.scanId as string);
    if (!snapshot) throw notFound("Discovery scan not found");
    res.json(snapshot);
  });

  return router;
}
