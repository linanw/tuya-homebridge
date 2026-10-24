import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A separate session per request makes redirect rejection and bounded buffering explicit.
private final class BoundedRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var bytes = Data()
    private var terminalError: Error?
    private var cancelled = false
    private let limit = 4 * 1024 * 1024

    func run(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                let config = URLSessionConfiguration.ephemeral
                config.httpCookieStorage = nil; config.urlCache = nil
                config.requestCachePolicy = .reloadIgnoringLocalCacheData
                config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 35
                let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
                self.session = session
                let task = session.dataTask(with: request); self.task = task
                lock.unlock(); task.resume()
            }
        }, onCancel: { self.cancel() })
    }

    private func cancel() {
        lock.lock(); cancelled = true; let task = task; lock.unlock(); task?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward a bearer token to a redirected origin, including same-host redirects.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            terminalError = MetadataError.invalidResponse; completionHandler(.cancel); return
        }
        guard response.expectedContentLength <= Int64(limit) else {
            terminalError = MetadataError.responseTooLarge; completionHandler(.cancel); return
        }
        self.response = http; completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= limit else {
            terminalError = MetadataError.responseTooLarge; dataTask.cancel(); return
        }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let continuation = continuation; self.continuation = nil; lock.unlock()
        defer { session.finishTasksAndInvalidate(); self.session = nil; self.task = nil }
        if let terminalError { continuation?.resume(throwing: terminalError) }
        else if let error { continuation?.resume(throwing: error) }
        else if let response { continuation?.resume(returning: (bytes, response)) }
        else { continuation?.resume(throwing: MetadataError.invalidResponse) }
    }
}

public actor MetadataHTTPClient {
    public let address: ServerAddress
    private let token: String
    public init(address: ServerAddress, token: String) throws {
        try ServerAddress.validateToken(token); self.address = address; self.token = token
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil,
                         accepted: Set<Int> = [200]) async throws -> Data {
        var request = URLRequest(url: address.endpoint(path))
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            let (data, response) = try await BoundedRequest().run(request)
            guard accepted.contains(response.statusCode) else {
                if response.statusCode == 404 && path.contains("/commands/") { throw MetadataError.commandNotFound }
                throw MetadataError.http(response.statusCode)
            }
            return data
        } catch let error as MetadataError { throw error }
        catch is CancellationError { throw CancellationError() }
        catch { throw MetadataError.network }
    }

    public func capabilities() async throws -> CapabilitiesDocument {
        let document = try JSONDecoder().decode(CapabilitiesDocument.self, from: await request("v1/capabilities"))
        try document.validate(); return document
    }
    public func snapshot() async throws -> MetadataSnapshot {
        try MetadataSnapshot.decode(await request("v1/metadata"))
    }
    public func submit(_ command: MetadataCommand) async throws -> CommandReceipt {
        let body = try JSONEncoder().encode(command)
        guard body.count <= 16 * 1024 else { throw MetadataError.invalidResponse }
        let result = try JSONDecoder().decode(CommandReceipt.self,
            from: await request("v1/metadata/commands", method: "POST", body: body, accepted: [202]))
        try result.validate(commandId: command.commandId, serverId: command.expected.serverId,
            sourceEpoch: command.expected.sourceEpoch)
        return result
    }
    public func receipt(commandID: String, serverID: String, sourceEpoch: String? = nil) async throws -> CommandReceipt {
        guard UUID(uuidString: commandID) != nil else { throw MetadataError.invalidResponse }
        let value = try JSONDecoder().decode(CommandReceipt.self,
            from: await request("v1/metadata/commands/\(commandID)"))
        try value.validate(commandId: commandID, serverId: serverID, sourceEpoch: sourceEpoch); return value
    }
    /// Only GETs an existing receipt. It never retries a mutation.
    public func awaitReceipt(_ initial: CommandReceipt, serverID: String, sourceEpoch: String? = nil,
                             timeout: TimeInterval = 90) async throws -> CommandReceipt {
        var value = initial; let deadline = Date().addingTimeInterval(timeout)
        while !value.status.isTerminal {
            guard Date() < deadline else { throw MetadataError.receiptTimeout }
            try await Task.sleep(nanoseconds: 1_000_000_000)
            value = try await receipt(commandID: value.commandId, serverID: serverID, sourceEpoch: sourceEpoch)
        }
        return value
    }
}
