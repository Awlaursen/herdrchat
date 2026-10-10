import Foundation
import NIOCore
import NIOPosix
@preconcurrency import NIOSSH

/// Cancellation must close a socket even while authentication is waiting. NIO
/// futures alone do not observe Swift task cancellation.
final class SshDialControl: @unchecked Sendable {
  private let lock = NSLock()
  private var channel: Channel?
  private var cancelled = false

  func attach(_ channel: Channel) {
    lock.lock()
    self.channel = channel
    let close = cancelled
    lock.unlock()
    if close { channel.close(promise: nil) }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let channel = channel
    lock.unlock()
    channel?.close(promise: nil)
  }
}

enum TailscaleOutput: Sendable { case stdout(ByteBuffer), stderr(ByteBuffer) }

struct TailscaleCommandFailed: Error { let exitCode: Int }

/// A credential-free SSH session on the existing NIOSSH dependency. Citadel
/// 0.12.1 swallows auth banners and fixes login at ten seconds. Owning this
/// pipeline lets check mode wait for browser approval, without patching Citadel
/// or changing the password/key transport. No Tailscale API token is involved.
final class TailscaleSession: @unchecked Sendable {
  private let channel: Channel
  private let group: MultiThreadedEventLoopGroup
  var isConnected: Bool { channel.isActive }

  private init(channel: Channel, group: MultiThreadedEventLoopGroup) {
    self.channel = channel
    self.group = group
  }

  static func connect(
    host: String, port: Int, username: String,
    validator: NIOSSHClientServerAuthenticationDelegate,
    control: SshDialControl,
    onBanner: @escaping @Sendable (String) -> Void,
    approvalTimeout: TimeAmount = .seconds(300)
  ) async throws -> TailscaleSession {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    let loop = group.next()
    let authenticated = loop.makePromise(of: Void.self)
    let auth = TailscaleAuthHandler(
      authenticated: authenticated, onBanner: onBanner, approvalTimeout: approvalTimeout
    )
    // The delegate is used only on this channel's event loop.
    nonisolated(unsafe) let validator = validator
    do {
      return try await withTaskCancellationHandler {
        let channel = try await ClientBootstrap(group: loop)
          .connectTimeout(.seconds(15))
          .channelInitializer { channel in
            control.attach(channel)
            do {
              try channel.pipeline.syncOperations.addHandlers(
              NIOSSHHandler(
                role: .client(SSHClientConfiguration(
                  userAuthDelegate: TailscaleNoneAuth(username: username),
                  serverAuthDelegate: validator
                )),
                allocator: channel.allocator,
                inboundChildChannelInitializer: { child, _ in
                  child.eventLoop.makeFailedFuture(SshFailure(
                    code: "transport_failed", message: "Unsolicited SSH channel refused."
                  ))
                }
              ),
              auth
              )
              return channel.eventLoop.makeSucceededVoidFuture()
            } catch { return channel.eventLoop.makeFailedFuture(error) }
          }
          .connect(host: host, port: port).get()
        try await authenticated.futureResult.get()
        try Task.checkCancellation()
        return TailscaleSession(channel: channel, group: group)
      } onCancel: { control.cancel() }
    } catch {
      // DNS/TCP can fail before the auth handler is installed. Complete its
      // promise too, so even that path leaves no unresolved NIO promise.
      authenticated.fail(error)
      control.cancel()
      try? await group.shutdownGracefully()
      if Task.isCancelled {
        throw SshFailure(code: "auth_cancelled", message: "SSH approval was cancelled. Try again when you are ready.")
      }
      throw error
    }
  }

  func close() async {
    try? await channel.close()
    try? await group.shutdownGracefully()
  }

  /// Each invocation opens exactly one command channel. Cancelling the reader
  /// closes that channel, including an otherwise silent tail, without replay.
  func readCommand(
    _ command: String,
    onStart: () -> Void,
    onChunk: (TailscaleOutput) -> Void
  ) async throws {
    let output = AsyncThrowingStream<TailscaleOutput, Error>.makeStream()
    let control = SshDialControl()
    output.continuation.onTermination = { _ in control.cancel() }
    let continuation = output.continuation
    try await withTaskCancellationHandler {
      let child = try await channel.eventLoop.flatSubmit { [channel] in
        let promise = channel.eventLoop.makePromise(of: Channel.self)
        let timeout = channel.eventLoop.scheduleTask(in: .seconds(15)) {
          promise.fail(SshFailure(code: "timeout", message: "The SSH command channel did not open in time."))
          // Prevent a delayed open from executing this command after failure.
          control.cancel()
        }
        promise.futureResult.whenComplete { _ in timeout.cancel() }
        do {
          let handler = try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
          handler.createChannel(promise, channelType: .session) { child, _ in
            control.attach(child)
            return child.pipeline.addHandler(TailscaleCommandHandler(output: continuation))
          }
          return promise.futureResult
        } catch {
          promise.fail(error)
          return promise.futureResult
        }
      }.get()
      do {
        try Task.checkCancellation()
        try await child.triggerUserOutboundEvent(
          SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)
        )
        onStart()
        for try await chunk in output.stream {
          try Task.checkCancellation()
          onChunk(chunk)
        }
        try Task.checkCancellation()
      } catch {
        control.cancel()
        throw error
      }
      control.cancel()
    } onCancel: { control.cancel() }
  }
}

private final class TailscaleNoneAuth: NIOSSHClientUserAuthenticationDelegate {
  let username: String
  private var offered = false
  init(username: String) { self.username = username }

  func nextAuthenticationType(
    availableMethods: NIOSSHAvailableUserAuthenticationMethods,
    nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
  ) {
    guard !offered else {
      nextChallengePromise.fail(SshFailure(
        code: "auth_failed", message: "Tailscale did not authorize SSH access. Check the SSH user and your tailnet policy."
      ))
      return
    }
    offered = true
    nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(
      username: username, serviceName: "ssh-connection", offer: .none
    ))
  }
}

private final class TailscaleAuthHandler: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  private let authenticated: EventLoopPromise<Void>
  private let onBanner: @Sendable (String) -> Void
  private let approvalTimeout: TimeAmount
  private var deadline: Scheduled<Void>?
  private var awaitingApproval = false
  private var finished = false

  init(authenticated: EventLoopPromise<Void>, onBanner: @escaping @Sendable (String) -> Void,
       approvalTimeout: TimeAmount) {
    self.authenticated = authenticated
    self.onBanner = onBanner
    self.approvalTimeout = approvalTimeout
  }

  func handlerAdded(context: ChannelHandlerContext) { arm(context, after: .seconds(30)) }

  private func arm(_ context: ChannelHandlerContext, after duration: TimeAmount) {
    deadline?.cancel()
    deadline = context.eventLoop.scheduleTask(in: duration) { [self] in
      fail(SshFailure(
        code: awaitingApproval ? "auth_timeout" : "connect_failed",
        message: awaitingApproval ? "SSH approval expired. Try again to get a new link." : "The SSH handshake timed out. Check the host and Tailscale connection."
      ))
      context.close(promise: nil)
    }
  }

  private func fail(_ error: Error) {
    guard !finished else { return }
    finished = true
    deadline?.cancel()
    authenticated.fail(error)
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let banner = event as? NIOUserAuthBannerEvent {
      // A banner can arrive before or during the none-auth request. Extend
      // once, so a server cannot keep the login alive by sending banners.
      if !awaitingApproval {
        awaitingApproval = true
        arm(context, after: approvalTimeout)
      }
      onBanner(String(banner.message.prefix(4096)))
    } else if event is UserAuthSuccessEvent, !finished {
      finished = true
      deadline?.cancel()
      authenticated.succeed(())
    }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    fail(SshFailure(code: "auth_failed", message: "The SSH server closed the login before approval completed."))
    context.fireChannelInactive()
  }

  func handlerRemoved(context: ChannelHandlerContext) {
    fail(SshFailure(code: "connect_failed", message: "The SSH connection closed before login completed."))
    deadline?.cancel()
  }
}

private final class TailscaleCommandHandler: ChannelInboundHandler {
  typealias InboundIn = SSHChannelData
  let output: AsyncThrowingStream<TailscaleOutput, Error>.Continuation
  private var exitCode: Int?

  init(output: AsyncThrowingStream<TailscaleOutput, Error>.Continuation) { self.output = output }

  func handlerAdded(context: ChannelHandlerContext) {
    // OpenSSH may send EOF before exit-status. Keep receiving channel events
    // until CLOSE rather than treating the half-close as a lost reply.
    context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure {
      context.fireErrorCaught($0)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let chunk = unwrapInboundIn(data)
    guard case .byteBuffer(let bytes) = chunk.data else { return }
    if chunk.type == .channel { output.yield(.stdout(bytes)) }
    if chunk.type == .stdErr { output.yield(.stderr(bytes)) }
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let status = event as? SSHChannelRequestEvent.ExitStatus { exitCode = status.exitStatus }
    if event is SSHChannelRequestEvent.ExitSignal { exitCode = 128 }
    if event is ChannelFailureEvent {
      output.finish(throwing: SshFailure(code: "transport_failed", message: "The SSH server refused the command."))
      context.close(promise: nil)
    }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    output.finish(throwing: error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    // EOF without exit status is a lost reply, never a successful command.
    if let exitCode {
      if exitCode == 0 { output.finish() }
      else { output.finish(throwing: TailscaleCommandFailed(exitCode: exitCode)) }
    } else {
      output.finish(throwing: SshFailure(code: "transport_failed", message: "The SSH command ended without an exit status."))
    }
    context.fireChannelInactive()
  }
}
