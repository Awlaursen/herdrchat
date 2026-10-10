import Foundation
import NIOCore
import NIOSSH

private final class BannerRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.lock(); defer { lock.unlock() }; return value }
  func add(_ phase: String, _ message: String?) {
    if phase == "banner", message?.contains("https://login.tailscale.com/a/") == true {
      lock.lock(); value += 1; lock.unlock()
    }
  }
}

private final class FixtureHostKey: NIOSSHClientServerAuthenticationDelegate {
  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    validationCompletePromise.succeed(()) // Only the disposable loopback fixture.
  }
}

func runTailscaleChecks(port: Int) async throws {
  var config = SshConfigRecord()
  config.port = port
  config.username = "slow"
  config.authKind = "tailscale"
  let banners = BannerRecorder()
  let connection = SshConnection(config: config, onAuth: { _, phase, message in banners.add(phase, message) })
  let began = Date()
  print("CHECK delayed approval")
  try await connection.connected()
  precondition(Date().timeIntervalSince(began) >= 10, "Fixture did not exercise delayed approval")
  precondition(banners.count == 1, "The approval banner never reached the app")
  print("CHECK command output")
  let output = try await connection.exec("ok", timeoutMs: 5000)
  precondition(output.stdout == "first\nsecond\n" && output.stderr == "detail" && output.exitCode == 0)
  let failure = try await connection.exec("fail", timeoutMs: 5000)
  precondition(failure.exitCode == 7 && failure.stderr == "detail")
  print("CHECK silent stream cancellation")
  let stream = try await connection.startStream("silent", startTimeoutMs: 5000,
    onLine: { _ in }, onEnd: { _ in }, onError: { _, _ in })
  print("CHECK cancel started stream")
  stream.cancel()
  await stream.value
  print("CHECK refused exec")
  do {
    _ = try await connection.exec("refused", timeoutMs: 5000)
    preconditionFailure("Refused exec was accepted")
  } catch { }
  await connection.close()
  print("PASS delayed none-auth, auth banner, output, exit status, cancellation, refused exec")

  print("CHECK denied auth")
  config.username = "denied"
  let denied = SshConnection(config: config)
  do { try await denied.connected(); preconditionFailure("Denied login was accepted") }
  catch let error as SshFailure { precondition(error.code == "auth_failed") }
  await denied.close()

  config.username = "fast"
  config.hostKeyFingerprint = "not-the-fixture-key"
  let changed = SshConnection(config: config)
  do { try await changed.connected(); preconditionFailure("Changed host key was accepted") }
  catch let error as SshFailure { precondition(error.code == "host_key_changed") }
  await changed.close()
  print("PASS auth denial and host-key mismatch")

  config.hostKeyFingerprint = nil
  config.username = "never"
  print("CHECK cancelled auth")
  let cancelled = SshConnection(config: config)
  let task = Task { try await cancelled.connected() }
  try await Task.sleep(nanoseconds: 500_000_000)
  await cancelled.close()
  do { try await task.value; preconditionFailure("Cancelled login was accepted") }
  catch let error as SshFailure { precondition(error.code == "auth_cancelled") }

  print("CHECK auth timeout")
  do {
    _ = try await TailscaleSession.connect(host: "127.0.0.1", port: port, username: "never",
      validator: FixtureHostKey(), control: SshDialControl(), onBanner: { _ in },
      approvalTimeout: .milliseconds(200))
    preconditionFailure("Expired approval was accepted")
  } catch let error as SshFailure { precondition(error.code == "auth_timeout") }
  print("PASS cancellation during approval and approval timeout")
}
