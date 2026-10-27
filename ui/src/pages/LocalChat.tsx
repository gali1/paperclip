import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

interface Turn {
  role: "user" | "assistant";
  body: string;
  source?: "command" | "model" | "unavailable";
}

const SUGGESTIONS = ["/help", "/providers", "/artifacts"];

/**
 * LOCAL — operator console.
 *
 * A plain chat with Paperclip's own API/model. It never creates tasks or
 * artifacts: the server handles known commands against real services and sends
 * free text to the configured model. Artifacts produced elsewhere in Paperclip
 * stay one link away (the artifact browser), exactly like any other artifact.
 */
export function LocalChat() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [artifactsUrl, setArtifactsUrl] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "LOCAL" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || !selectedCompanyId || busy) return;
    setBusy(true);
    setInput("");
    setTurns((current) => [...current, { role: "user", body: message }]);
    try {
      const response = await api.post<{
        reply: string;
        source: "command" | "model" | "unavailable";
        artifactsUrl: string;
      }>(`/companies/${selectedCompanyId}/local-chat`, { message });
      setArtifactsUrl(response.artifactsUrl);
      setTurns((current) => [
        ...current,
        { role: "assistant", body: response.reply, source: response.source },
      ]);
    } catch (error) {
      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          body: error instanceof Error ? error.message : "The local console request failed.",
          source: "unavailable",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">LOCAL</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Chat with this instance's API and model. No task or artifact is created unless you ask
          for one explicitly; generated artifacts appear in the artifact browser like any other.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {turns.length === 0 && (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>Try a command:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}

        <ul className="space-y-3">
          {turns.map((turn, index) => (
            <li
              key={`${turn.role}-${index}`}
              className={cn(
                "max-w-(--pct-85) whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                turn.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "bg-muted/40 text-foreground",
              )}
            >
              {turn.body}
              {turn.role === "assistant" && turn.source && (
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {turn.source === "command" ? "local API" : turn.source === "model" ? "model" : "unavailable"}
                  {turn.source === "unavailable" && artifactsUrl ? (
                    <>
                      {" · "}
                      <a className="underline" href={artifactsUrl}>
                        artifacts
                      </a>
                    </>
                  ) : null}
                </span>
              )}
            </li>
          ))}
          {busy && (
            <li className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
            </li>
          )}
        </ul>
        <div ref={endRef} />
      </div>

      <form
        className="flex items-center gap-2 border-t border-border/60 px-6 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <Input
          aria-label="LOCAL message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={selectedCompanyId ? "Ask about this instance, or type /help" : "Select a company first"}
          disabled={!selectedCompanyId || busy}
        />
        <Button type="submit" size="sm" disabled={!selectedCompanyId || busy || !input.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}
