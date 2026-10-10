import type { SshApprovalEvent } from '../sshApproval';

const listeners = new Set<(event: SshApprovalEvent | null) => void>();
export function subscribeDemoSshApproval(listener: (event: SshApprovalEvent | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function showDemoSshApproval(): void {
  const event: SshApprovalEvent = {
    connectionId: 'demo-ssh-approval', attemptId: 'demo', host: 'demo.tailnet.ts.net', username: 'demo',
    phase: 'banner', message: 'Demo approval — no network request will be made.\nhttps://login.tailscale.com/a/demo',
  };
  listeners.forEach((listener) => listener(event));
}
export function finishDemoSshApproval(): void { listeners.forEach((listener) => listener(null)); }
