/** Authentication events are transient. Approval URLs never enter SQLite,
 * Keychain, logs, or analytics. A late event cannot reopen a finished attempt. */
export interface SshApprovalEvent {
  connectionId: string;
  attemptId: string;
  host: string;
  username: string;
  phase: 'started' | 'banner' | 'finished';
  message?: string;
}
export type SshApprovals = Readonly<Record<string, SshApprovalEvent>>;

export function reduceSshApprovals(state: SshApprovals, event: SshApprovalEvent): SshApprovals {
  if (event.phase === 'started') return { ...state, [event.connectionId]: event };
  if (state[event.connectionId]?.attemptId !== event.attemptId) return state;
  if (event.phase === 'finished') {
    const next = { ...state };
    delete next[event.connectionId];
    return next;
  }
  return { ...state, [event.connectionId]: event };
}

/** Only official Tailscale approval links get an action. Never automatically
 * open server-supplied URLs, or accept credentials, custom schemes or lookalike hosts. */
export function tailscaleApprovalUrl(message: string): string | null {
  const links = message.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  for (const candidate of links) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'login.tailscale.com' &&
          url.port === '' && url.username === '' && url.password === '' &&
          /^\/a\/[A-Za-z0-9_-]+$/.test(url.pathname) && url.search === '' && url.hash === '') {
        return url.href;
      }
    } catch { /* Display the banner, but do not turn malformed text into an action. */ }
  }
  return null;
}

export function displaySshBanner(message: string): string {
  // Strip terminal escape/control sequences from the untrusted server banner.
  return message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 4096);
}
