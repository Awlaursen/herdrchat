import Native from '../HerdrSshModule';
import { connect, streamLines, type SshConfig } from '..';
import { DONE_MARK } from '../../../../src/lib/herdr/doneMark';
import { SshHerdrTransport } from '../../../../src/lib/herdr/sshTransport';

jest.mock('../HerdrSshModule', () => ({
  __esModule: true,
  default: {
    connect: jest.fn(), disconnect: jest.fn(), exec: jest.fn(),
    startStream: jest.fn(), stopStream: jest.fn(), addListener: jest.fn(),
  },
}));
const native = jest.mocked(Native);
const config: SshConfig = { host: '127.0.0.1', port: 22, username: 'test', auth: { kind: 'password', password: 'fixture' } };
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

beforeEach(() => {
  jest.resetAllMocks();
  native.connect.mockResolvedValue({ ok: true, fingerprint: 'pin-A' });
  native.disconnect.mockResolvedValue(undefined);
  // Like a shell: the transport's `&& printf <mark>` prints the mark on exit 0.
  native.exec.mockImplementation(async (_id: string, command: string) => ({
    ok: true, stdout: command.includes(DONE_MARK) ? DONE_MARK : '', stderr: '', exitCode: 0,
  }));
  native.startStream.mockResolvedValue({ ok: true });
  native.stopStream.mockResolvedValue(undefined);
  native.addListener.mockReturnValue({ remove: jest.fn() });
});

it('shares opening and waits for durable pin storage before any command', async () => {
  let saved!: () => void;
  const persist = jest.fn(() => new Promise<void>(resolve => { saved = resolve; }));
  const transport = new SshHerdrTransport('host', async () => config, persist);
  const commands = [transport.exec('one', 1000), transport.exec('two', 1000)];
  await flush();
  expect(native.connect).toHaveBeenCalledTimes(1);
  expect(native.exec).not.toHaveBeenCalled();
  saved();
  await Promise.all(commands);
  expect(native.exec).toHaveBeenCalledTimes(2);
});

it('closes after a failed pin save, executes nothing, and permits a later fresh attempt', async () => {
  const persist = jest.fn().mockRejectedValueOnce(new Error('Keychain write failed')).mockResolvedValue(undefined);
  const transport = new SshHerdrTransport('host', async () => config, persist);
  await expect(transport.exec('write', 1000)).resolves.toMatchObject({ ok: false });
  expect(native.disconnect).toHaveBeenCalledWith('host');
  expect(native.exec).not.toHaveBeenCalled();
  await expect(transport.exec('read', 1000)).resolves.toMatchObject({ ok: true });
  expect(native.connect).toHaveBeenCalledTimes(2);
});

it('aborts 20 silent streams without waiting for a host event or leaking listeners', async () => {
  const remove = jest.fn();
  native.addListener.mockReturnValue({ remove });
  for (let i = 0; i < 20; i += 1) {
    const controller = new AbortController();
    const reader = streamLines('host', 'tail', 1000, controller.signal);
    const waiting = reader.next();
    await flush();
    controller.abort();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
  }
  expect(remove).toHaveBeenCalledTimes(60);
  expect(new Set(native.stopStream.mock.calls.map(call => call[0])).size).toBe(20);
});

it('stops again after an aborted start registers its native handle', async () => {
  let started!: () => void;
  native.startStream.mockImplementation(() => new Promise(resolve => {
    started = () => resolve({ ok: true });
  }));
  const controller = new AbortController();
  const waiting = streamLines('host', 'tail', 1000, controller.signal).next();
  controller.abort();
  expect(native.stopStream).toHaveBeenCalledTimes(1);
  started();
  await expect(waiting).resolves.toMatchObject({ done: true });
  expect(native.stopStream).toHaveBeenCalledTimes(2);
});

it('does not start a stream that was already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(streamLines('host', 'tail', 1000, controller.signal).next()).resolves.toMatchObject({ done: true });
  expect(native.startStream).not.toHaveBeenCalled();
});

it('connects using Tailscale without flattening it into an empty private key', async () => {
  await connect('tail', { ...config, auth: { kind: 'tailscale' } });
  expect(native.connect).toHaveBeenCalledWith('tail', {
    host: config.host, port: config.port, username: config.username,
    hostKeyFingerprint: null, authKind: 'tailscale',
  });
});

it('checks native liveness again before a later command begins its short deadline', async () => {
  const transport = new SshHerdrTransport('tail', async () => ({ ...config, auth: { kind: 'tailscale' } }));
  await transport.exec('first', 1000);
  let approve!: () => void;
  native.connect.mockImplementationOnce(() => new Promise(resolve => {
    approve = () => resolve({ ok: true, fingerprint: 'pin-A' });
  }));
  const later = transport.exec('second', 1000);
  await flush();
  expect(native.connect).toHaveBeenCalledTimes(2);
  expect(native.exec).toHaveBeenCalledTimes(1);
  approve();
  await expect(later).resolves.toMatchObject({ ok: true });
  expect(native.exec).toHaveBeenCalledTimes(2);
});

it('never executes a command after approval was cancelled or expired', async () => {
  native.connect.mockResolvedValue({ ok: false, code: 'auth_cancelled', message: 'Cancelled' });
  const transport = new SshHerdrTransport('tail', async () => ({ ...config, auth: { kind: 'tailscale' } }));
  await expect(transport.exec('write', 1000)).resolves.toMatchObject({ code: 'auth_cancelled' });
  expect(native.exec).not.toHaveBeenCalled();
});

it('does not reconnect or execute after a disposed test finishes loading its config', async () => {
  let loaded!: (config: SshConfig) => void;
  const transport = new SshHerdrTransport('test', () => new Promise(resolve => { loaded = resolve; }));
  const command = transport.exec('write', 1000);
  await transport.close();
  loaded(config);
  await expect(command).resolves.toMatchObject({ ok: false, code: 'auth_cancelled' });
  expect(native.connect).not.toHaveBeenCalled();
  expect(native.exec).not.toHaveBeenCalled();
});

it('does not execute after an old approval completes following close', async () => {
  let approve!: () => void;
  native.connect.mockImplementation(() => new Promise(resolve => {
    approve = () => resolve({ ok: true, fingerprint: 'pin-A' });
  }));
  const transport = new SshHerdrTransport('test', async () => config);
  const command = transport.exec('write', 1000);
  await flush();
  await transport.close();
  approve();
  await expect(command).resolves.toMatchObject({ ok: false, code: 'auth_cancelled' });
  expect(native.exec).not.toHaveBeenCalled();
});

it('reuses loaded credentials and the persisted pin while checking native liveness', async () => {
  const load = jest.fn(async () => config);
  const save = jest.fn(async () => undefined);
  const transport = new SshHerdrTransport('host', load, save);
  await transport.exec('first', 1000);
  await transport.exec('second', 1000);
  expect(load).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(native.connect).toHaveBeenCalledTimes(2);
  expect(native.connect).toHaveBeenLastCalledWith('host', expect.objectContaining({ hostKeyFingerprint: 'pin-A' }));
});
