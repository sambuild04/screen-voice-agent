/**
 * Bridge between the RealtimeSession transport and tool functions.
 * Allows tools (samuel.ts) to inject images directly into the
 * active Realtime conversation without a separate Vision API call.
 */

type SendImageFn = (base64Jpeg: string) => void;

let sendImageFn: SendImageFn | null = null;

export function registerSendImage(fn: SendImageFn | null) {
  sendImageFn = fn;
}

/**
 * Inject a captured page image directly into the Realtime session.
 * Returns true if the image was sent, false if no session is active.
 */
export function sendImageToSession(base64Jpeg: string): boolean {
  if (!sendImageFn) return false;
  sendImageFn(base64Jpeg);
  return true;
}
