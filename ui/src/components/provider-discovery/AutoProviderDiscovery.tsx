import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PROVIDER_STATUS_LABEL,
  providerDiscoveryApi,
  type ProviderFinding,
  type ProviderFindingStatus,
  type ProviderScan,
} from "@/api/provider-discovery";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 500;

const STATUS_STYLE: Record<ProviderFindingStatus, string> = {
  ready: "text-emerald-600 border-emerald-600/40",
  needs_configuration: "text-amber-600 border-amber-600/40",
  compatible_unverified: "text-sky-600 border-sky-600/40",
  detected_unverified: "text-muted-foreground",
  not_reachable: "text-destructive border-destructive/40",
};

export interface AutoProviderSelection {
  providerKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  providerId: string;
  credentialPresent: boolean;
}

/**
 * AUTO provider discovery.
 *
 * Starts a scan, polls its stage-by-stage progress, and lets the user adopt one
 * discovered provider. Adoption only *suggests* configuration to the caller —
 * the panel never writes agent or connection configuration itself, and it never
 * receives a credential value.
 */
export function AutoProviderDiscovery({
  companyId,
  providerKeys,
  onSelect,
  className,
}: {
  companyId: string;
  /** Provider keys the current adapter form understands. */
  providerKeys: Record<string, string>;
  onSelect: (selection: AutoProviderSelection) => void;
  className?: string;
}) {
  const [scan, setScan] = useState<ProviderScan | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "ready" | "needs">("all");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const poll = useCallback(
    async (scanId: string) => {
      try {
        const next = await providerDiscoveryApi.get(companyId, scanId);
        if (!mounted.current) return;
        setScan(next);
        if (next.status === "running") {
          timer.current = setTimeout(() => void poll(scanId), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : "Could not read the scan");
      }
    },
    [companyId],
  );

  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const created = await providerDiscoveryApi.start(companyId);
      if (!mounted.current) return;
      setScan(created);
      timer.current = setTimeout(() => void poll(created.id), POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the scan");
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [companyId, poll, starting]);

  const cancel = useCallback(async () => {
    if (!scan || scan.status !== "running") return;
    try {
      const next = await providerDiscoveryApi.cancel(companyId, scan.id);
      if (mounted.current) setScan(next);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not cancel the scan");
    }
  }, [companyId, scan]);

  const running = scan?.status === "running" || starting;
  const findings = scan?.findings ?? [];
  const visible = findings.filter((finding) => {
    if (filter === "ready") return finding.status === "ready";
    if (filter === "needs") return finding.status !== "ready";
    return true;
  });
  const recommendable = (finding: ProviderFinding) =>
    Boolean(finding.setup.providerKey && providerKeys[finding.setup.providerKey]) ||
    finding.status === "ready";

  return (
    <div className={cn("rounded-lg border border-border/70 bg-muted/20 p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">AUTO — find providers on this instance</p>
          <p className="text-xs text-muted-foreground">
            Scans environment variables, bounded config files, documented local ports and
            reachable containers. No credential is sent anywhere and no billable call is made.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void cancel()}>
              <X className="mr-2 h-3.5 w-3.5" /> Cancel
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={starting} onClick={() => void start()}>
              {starting ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : scan ? (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Search className="mr-2 h-3.5 w-3.5" />
              )}
              {scan ? "Rescan" : "AUTO scan"}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      {scan && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {scan.status === "running"
                ? `Scanning — ${scan.stage?.replace(/_/g, " ") ?? "starting"}…`
                : scan.status === "cancelled"
                  ? "Scan cancelled — results are partial."
                  : scan.status === "failed"
                    ? "Scan failed."
                    : `Scan complete — ${findings.length} provider(s).`}
            </span>
            {scan.deployment.mode === "container" && (
              <Badge variant="outline">container{scan.deployment.hostGatewayCandidates[0] ? ` via ${scan.deployment.hostGatewayCandidates[0]}` : ""}</Badge>
            )}
          </div>

          <div className="flex flex-wrap gap-1">
            {scan.stages.map((stage) => (
              <span
                key={stage.stage}
                title={stage.detail ?? stage.status}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[11px]",
                  stage.status === "completed" && "border-emerald-600/30 text-emerald-700",
                  stage.status === "running" && "border-sky-600/40 text-sky-700",
                  stage.status === "failed" && "border-destructive/40 text-destructive",
                  (stage.status === "pending" || stage.status === "skipped") && "border-border text-muted-foreground",
                )}
              >
                {stage.stage.replace(/_/g, " ")}
              </span>
            ))}
          </div>

          {findings.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {(["all", "ready", "needs"] as const).map((tab) => (
                <Button
                  key={tab}
                  type="button"
                  size="sm"
                  variant={filter === tab ? "secondary" : "ghost"}
                  onClick={() => setFilter(tab)}
                >
                  {tab === "all" ? `All (${findings.length})` : tab === "ready" ? "Ready" : "Needs setup"}
                </Button>
              ))}
            </div>
          )}

          {visible.length === 0 && scan.status !== "running" && (
            <p className="text-xs text-muted-foreground">
              {findings.length === 0
                ? "No providers were found. Check the scan notes below — a skipped stage means discovery could not see that source."
                : "Nothing matches this filter."}
            </p>
          )}

          <ul className="space-y-2">
            {visible.map((finding) => (
              <li
                key={finding.id}
                className="rounded-md border border-border/60 bg-background/60 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{finding.label}</span>
                  <Badge variant="outline" className={STATUS_STYLE[finding.status]}>
                    {PROVIDER_STATUS_LABEL[finding.status]}
                  </Badge>
                  <Badge variant="secondary">{finding.category}</Badge>
                  <Badge variant="outline">{finding.location}</Badge>
                  {finding.credential === "present" && (
                    <Badge variant="outline">
                      key in {finding.credentialEnvKeys[0] ?? "config"}
                    </Badge>
                  )}
                  {finding.credential === "missing" && <Badge variant="outline">key required</Badge>}
                </div>

                {finding.endpoint && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{finding.endpoint}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {finding.sources.map((source) => source.detail).join(" · ")}
                </p>
                {finding.models.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Models: {finding.models.slice(0, 4).join(", ")}
                    {finding.models.length > 4 ? ` +${finding.models.length - 4}` : ""}
                  </p>
                )}
                {finding.requirements.length > 0 && (
                  <p className="mt-1 text-xs text-amber-600">{finding.requirements.join(" · ")}</p>
                )}
                {finding.warnings.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {finding.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}

                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={!recommendable(finding)}
                  aria-label={`Use ${finding.label}`}
                  onClick={() =>
                    onSelect({
                      providerId: finding.providerId,
                      providerKey: finding.setup.providerKey,
                      defaultModel: finding.setup.defaultModel,
                      baseUrl: finding.setup.baseUrl,
                      credentialPresent: finding.credential === "present",
                    })
                  }
                >
                  Use this
                </Button>
                {!recommendable(finding) && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    No matching provider field in this form.
                  </span>
                )}
              </li>
            ))}
          </ul>

          {(scan.limitations.length > 0 || scan.warnings.length > 0) && (
            <details className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Scan notes ({scan.limitations.length + scan.warnings.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {[...scan.warnings, ...scan.limitations].map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
