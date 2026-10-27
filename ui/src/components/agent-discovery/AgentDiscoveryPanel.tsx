import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { agentsApi, type AgentDiscoveryReport, type DiscoveredAgent } from "@/api/agents";
import { cn } from "@/lib/utils";

/**
 * Deployment-aware discovery panel.
 *
 * Runs the read-only discovery endpoint for one adapter type and lets the user
 * adopt a candidate by applying its `configPatch`. It never decides on its own:
 * detection is automatic, adoption is a click.
 */
export function AgentDiscoveryPanel({
  companyId,
  adapterType,
  onApply,
  className,
  autoRun = false,
}: {
  companyId: string;
  adapterType: string;
  onApply?: (candidate: DiscoveredAgent) => void;
  className?: string;
  autoRun?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AgentDiscoveryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const autoRunOnce = useRef(false);

  async function run(refresh: boolean) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await agentsApi.discover(companyId, adapterType, { refresh });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setStarted(true);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!autoRun || autoRunOnce.current) return;
    autoRunOnce.current = true;
    void run(false);
  // Discovery should run once per mount; re-running on every render would
  // hammer the probe endpoint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const candidates = report?.candidates ?? [];

  return (
    <div className={cn("rounded-lg border border-border/70 bg-muted/20 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Detect agents on this instance</p>
          <p className="text-xs text-muted-foreground">
            Looks for installed CLIs, documented API ports, running containers and configured
            endpoints. Nothing is created or changed until you choose a result.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void run(Boolean(report))}
        >
          {loading ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="mr-2 h-3.5 w-3.5" />
          )}
          {report ? "Scan again" : "Detect"}
        </Button>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {report?.deployment.mode === "container" && report.deployment.hostGatewayCandidates.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Running in a container. Host-native agents must listen on all interfaces; Paperclip
          reaches them through {report.deployment.hostGatewayCandidates[0]}.
        </p>
      )}

      {started && candidates.length === 0 && !error && (
        <p className="mt-3 text-xs text-muted-foreground">
          {report?.notes[0] ?? "Nothing reachable was found for this adapter."}
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="mt-3 space-y-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="rounded-md border border-border/60 bg-background/60 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{candidate.label}</span>
                <Badge variant="secondary">{candidate.source.replace("_", " ")}</Badge>
                {candidate.reachable ? (
                  <Badge variant="outline" className="text-emerald-600">
                    <Check className="mr-1 h-3 w-3" /> reachable
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600">
                    not reachable
                  </Badge>
                )}
                {candidate.validationStatus && candidate.validationStatus !== "skipped" && (
                  <Badge variant="outline">test: {candidate.validationStatus}</Badge>
                )}
              </div>
              {candidate.executablePath && (
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {candidate.executablePath}
                </p>
              )}
              {candidate.endpoint && (
                <p className="mt-1 font-mono text-xs text-muted-foreground">{candidate.endpoint}</p>
              )}
              {candidate.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-600">
                  {candidate.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {candidate.requiredInputs.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Still required: {candidate.requiredInputs.join(", ")}
                </p>
              )}
              {onApply && Object.keys(candidate.configPatch).length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  aria-label={`Use ${candidate.label}`}
                  onClick={() => onApply(candidate)}
                >
                  Use this
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
