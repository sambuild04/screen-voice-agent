import { useCallback, useEffect, useState } from "react";
import {
  type PluginProposal,
  type PluginBuildProgress,
  registerPluginProposalChange,
  registerPluginBuildProgress,
  clearPluginProposal,
  sendTextAndRespond,
} from "../lib/session-bridge";

const PHASE_LABELS: Record<string, string> = {
  generating: "Generating code…",
  validating: "Validating…",
  retrying: "Fixing issue, retrying…",
  checking: "Quality check…",
  installing: "Installing plugin…",
  reloading: "Loading into session…",
  done: "Ready!",
  error: "Failed",
};

export function PluginApproval() {
  const [proposal, setProposal] = useState<PluginProposal | null>(null);
  const [build, setBuild] = useState<PluginBuildProgress | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    registerPluginProposalChange((p) => {
      setExiting(false);
      setProposal(p);
    });
    registerPluginBuildProgress((b) => setBuild(b));
    return () => {
      registerPluginProposalChange(null);
      registerPluginBuildProgress(null);
    };
  }, []);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setProposal(null);
      setExiting(false);
      clearPluginProposal();
    }, 300);
  }, []);

  const handleApprove = useCallback(() => {
    if (!proposal) return;
    const name = proposal.name;
    dismiss();
    sendTextAndRespond(
      `[System: User APPROVED plugin "${name}". Proceed — call write_plugin now.]`,
    );
  }, [proposal, dismiss]);

  const handleReject = useCallback(() => {
    if (!proposal) return;
    const name = proposal.name;
    dismiss();
    sendTextAndRespond(
      `[System: User REJECTED plugin "${name}". Do not create it. Acknowledge briefly.]`,
    );
  }, [proposal, dismiss]);

  // Build progress card — shown after approval while plugin is being generated
  if (build) {
    const isDone = build.phase === "done";
    const isError = build.phase === "error";
    const progressPct =
      build.phase === "generating" ? 20
        : build.phase === "validating" ? 35
          : build.phase === "retrying" ? 25
            : build.phase === "checking" ? 50
              : build.phase === "installing" ? 70
                : build.phase === "reloading" ? 90
                  : 100;

    return (
      <div className={`plugin-approval plugin-build ${isDone ? "plugin-build-done" : ""} ${isError ? "plugin-build-error" : ""}`}>
        <div className="plugin-approval-header">
          {isDone ? "Tool added" : isError ? "Build failed" : "Building tool"}: <span className="plugin-approval-name">{build.name}</span>
        </div>
        <div className="plugin-build-status">
          {PHASE_LABELS[build.phase] || build.phase}
        </div>
        {!isDone && !isError && (
          <div className="plugin-build-track">
            <div className="plugin-build-fill" style={{ width: `${progressPct}%` }} />
          </div>
        )}
        {isError && build.error && (
          <p className="plugin-build-error-msg">{build.error}</p>
        )}
      </div>
    );
  }

  // Proposal approval card
  if (!proposal) return null;

  return (
    <div className={`plugin-approval ${exiting ? "plugin-approval-exit" : ""}`}>
      <div className="plugin-approval-header">
        New tool: <span className="plugin-approval-name">{proposal.name}</span>
      </div>
      <p className="plugin-approval-summary">{proposal.summary}</p>
      <div className="plugin-approval-actions">
        <button onClick={handleApprove} className="plugin-approval-btn plugin-approval-btn-yes">
          Approve
        </button>
        <button onClick={handleReject} className="plugin-approval-btn plugin-approval-btn-no">
          Reject
        </button>
      </div>
    </div>
  );
}
