import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/invoke-bridge";
import {
  registerSetAudioBufferActive,
  notifyAudioBufferState,
} from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";

// Pull-model ambient audio buffer. Owns the lifecycle of the
// ScreenCaptureKit "buffer" consumer used by the model's recall_audio tool.
//
// Privacy posture:
// - Gated on the persistent privacy.audio_listen pref. Default OFF.
// - When OFF, the model's recall_audio returns reason='buffer_off'. It
//   then calls listen_in_background(active=true), which is marked
//   `needsApproval: true` — the user sees a clear approval card and
//   chooses Allow / Deny. On Allow, the tool flips privacy.audio_listen
//   true (persisting the choice), the hook auto-acquires the capture,
//   and the user is asked to replay the clip so the now-running buffer
//   has something to recall.
// - Once allowed, the buffer just works across sessions until the user
//   revokes via settings or `listen_in_background(active=false)`.
//
// Design notes:
// - One desired flag, one effective flag. desired = "user/agent wants
//   it on for this session"; effective = "actually running" (gated on
//   session connect AND privacy). Splitting them keeps the IPC effect
//   idempotent.
// - desired defaults true so the buffer comes alive automatically the
//   moment privacy is granted and the session is connected — no extra
//   tool call needed.

export interface UseAudioBufferReturn {
  audioBufferActive: boolean;
}

export function useAudioBuffer(
  sessionStatus: ConnectionStatus,
  audioListenAllowed: boolean,
): UseAudioBufferReturn {
  const [desired, setDesired] = useState(true);
  const [effective, setEffective] = useState(false);

  useEffect(() => {
    registerSetAudioBufferActive((next) => setDesired(next));
    return () => registerSetAudioBufferActive(null);
  }, []);

  useEffect(() => {
    setEffective(desired && audioListenAllowed && sessionStatus === "connected");
  }, [desired, audioListenAllowed, sessionStatus]);

  useEffect(() => {
    notifyAudioBufferState(effective);
  }, [effective]);

  // Idempotent IPC effect — runs start/stop only on real transitions.
  // The ref guards against React strict-mode double-invocation in dev.
  const ipcRunningRef = useRef(false);
  useEffect(() => {
    if (effective && !ipcRunningRef.current) {
      ipcRunningRef.current = true;
      invoke("start_audio_buffer").catch((e) =>
        console.warn("[audio-buffer] start failed:", e),
      );
    } else if (!effective && ipcRunningRef.current) {
      ipcRunningRef.current = false;
      invoke("stop_audio_buffer").catch(() => {});
    }
    return () => {
      if (!effective && ipcRunningRef.current) {
        ipcRunningRef.current = false;
        invoke("stop_audio_buffer").catch(() => {});
      }
    };
  }, [effective]);

  return { audioBufferActive: effective };
}
