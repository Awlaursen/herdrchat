import { act, fireEvent, render } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import Native from '../../../../modules/herdr-ssh/src/HerdrSshModule';
import { ApprovalDialog, SshApprovalPrompt } from '../SshApprovalPrompt';
import type { SshApprovalEvent } from '@/lib/sshApproval';

jest.mock('../../../../modules/herdr-ssh/src/HerdrSshModule', () => ({
  __esModule: true, default: { addListener: jest.fn(), cancelAuth: jest.fn(async () => undefined) },
}));
jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => jest.requireActual('react-native-reanimated/mock'));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => undefined), dismissBrowser: jest.fn() }));
jest.mock('@/theme/ThemeProvider', () => ({
  useTheme: () => ({ colors: jest.requireActual('@/theme/tokens').darkPalette, reduceMotion: true }),
}));
const approval: SshApprovalEvent = {
  connectionId: 'host', attemptId: 'one', host: 'server.tailnet.ts.net', username: 'alice',
  phase: 'banner', message: 'Approve at https://login.tailscale.com/a/test',
};
beforeEach(() => jest.clearAllMocks());

it('opens an approval only after a tap and waits for the server after browser return', async () => {
  const screen = await render(<ApprovalDialog approval={approval} onCancel={jest.fn()} />);
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('ssh-auth-open'));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://login.tailscale.com/a/test');
  expect(screen.getByText('Waiting for the SSH server…')).toBeOnTheScreen();
});
it('shows unrecognized banners without a browser action', async () => {
  const screen = await render(<ApprovalDialog approval={{ ...approval, message: 'Visit https://evil.test/' }} onCancel={jest.fn()} />);
  expect(screen.queryByTestId('ssh-auth-open')).toBeNull();
  expect(screen.getByTestId('ssh-auth-banner')).toHaveTextContent('Visit https://evil.test/');
});
it('cancels only the displayed attempt and removes the listener on unmount', async () => {
  let event!: (event: SshApprovalEvent) => void;
  const remove = jest.fn();
  jest.mocked(Native.addListener).mockImplementation((_name, callback) => {
    event = callback as (event: SshApprovalEvent) => void;
    return { remove };
  });
  const screen = await render(<SshApprovalPrompt />);
  await act(() => { event({ ...approval, phase: 'started' }); event(approval); });
  await fireEvent.press(screen.getByTestId('ssh-auth-cancel'));
  expect(Native.cancelAuth).toHaveBeenCalledWith('host', 'one');
  expect(screen.queryByText('Approve Tailscale SSH')).toBeNull();
  await act(() => event(approval));
  expect(screen.queryByText('Approve Tailscale SSH')).toBeNull();
  await screen.unmount();
  expect(remove).toHaveBeenCalled();
});
it('dismisses approval only when the matching SSH attempt finishes', async () => {
  let event!: (event: SshApprovalEvent) => void;
  jest.mocked(Native.addListener).mockImplementation((_name, callback) => {
    event = callback as (event: SshApprovalEvent) => void;
    return { remove: jest.fn() };
  });
  const screen = await render(<SshApprovalPrompt />);
  await act(() => { event({ ...approval, phase: 'started' }); event(approval); });
  await act(() => event({ ...approval, attemptId: 'old', phase: 'finished' }));
  expect(screen.getByText('Approve Tailscale SSH')).toBeOnTheScreen();
  await act(() => event({ ...approval, phase: 'finished' }));
  expect(screen.queryByText('Approve Tailscale SSH')).toBeNull();
});
