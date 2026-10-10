import { displaySshBanner, reduceSshApprovals, tailscaleApprovalUrl, type SshApprovalEvent } from '../sshApproval';

const start: SshApprovalEvent = { connectionId: 'host', attemptId: 'one', host: 'host.tailnet.ts.net', username: 'alice', phase: 'started' };
it('recognizes a check-mode link in a multi-line SSH banner', () => {
  expect(tailscaleApprovalUrl('To authenticate, visit:\nhttps://login.tailscale.com/a/Abc_123-xy\n')).toBe('https://login.tailscale.com/a/Abc_123-xy');
});
it.each([
  'http://login.tailscale.com/a/key', 'https://login.tailscale.com.evil.test/a/key',
  'https://login.tailscale.com@evil.test/a/key', 'https://user@login.tailscale.com/a/key',
  'https://login.tailscale.com:444/a/key', 'javascript:alert(1)', 'file:///secret',
  'https://login.tailscale.com/a/key?redirect=https://evil.test', 'https://login.tailscale.com/a/key#x',
  'https://login.tailscale.com/a/../../evil', 'https://evil.test/a/key',
])('does not offer to open an untrusted link: %s', (message) => {
  expect(tailscaleApprovalUrl(message)).toBeNull();
});
it('does not resurrect finished or replaced auth attempts', () => {
  let state = reduceSshApprovals({}, start);
  state = reduceSshApprovals(state, { ...start, phase: 'banner', message: 'approve' });
  expect(state.host?.message).toBe('approve');
  state = reduceSshApprovals(state, { ...start, attemptId: 'two' });
  const current = state;
  expect(reduceSshApprovals(state, { ...start, phase: 'finished' })).toBe(current);
  expect(reduceSshApprovals(state, { ...start, phase: 'banner' })).toBe(current);
  state = reduceSshApprovals(state, { ...start, attemptId: 'two', phase: 'finished' });
  expect(Object.keys(state)).toHaveLength(0);
  expect(reduceSshApprovals(state, { ...start, attemptId: 'two', phase: 'banner' })).toBe(state);
});
it('keeps different hosts independent', () => {
  let state = reduceSshApprovals({}, start);
  state = reduceSshApprovals(state, { ...start, connectionId: 'second' });
  state = reduceSshApprovals(state, { ...start, phase: 'finished' });
  expect(Object.keys(state)).toEqual(['second']);
});
it('strips terminal control sequences and bounds banner size', () => {
  expect(displaySshBanner('\x1b[31mApprove\x1b[0m\x00\nnow')).toBe('Approve\nnow');
  expect(displaySshBanner('x'.repeat(10000))).toHaveLength(4096);
});
