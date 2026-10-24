import Foundation

public struct ServerAddress: Equatable, Sendable {
    public let baseURL: URL
    public var credentialScope: String { baseURL.absoluteString }

    public init(_ input: String) throws {
        guard var parts = URLComponents(string: input), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else { throw MetadataError.invalidURL }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { throw MetadataError.insecureURL }
        guard !parts.path.split(separator: "/").contains(".."), !parts.path.contains("\\") else {
            throw MetadataError.invalidURL
        }
        parts.scheme = scheme; parts.host = host
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        guard let url = parts.url else { throw MetadataError.invalidURL }
        baseURL = url
    }

    public func endpoint(_ path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    }

    public static func validateToken(_ token: String) throws {
        guard token.utf8.count >= 32, token.utf8.count <= 4096,
              token.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else {
            throw MetadataError.invalidToken
        }
    }
}
