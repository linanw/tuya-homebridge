import Foundation
import Security
import TuyaMetadataCore

enum KeychainTokenStore {
    private static let service = "org.linanw.TuyaMetadataCompanion.server-token.v1"

    static func read(for address: ServerAddress) throws -> String? {
        var query = base(address)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { throw TokenError.unavailable }
        return token
    }

    static func save(_ token: String, for address: ServerAddress) throws {
        try ServerAddress.validateToken(token)
        var item = base(address)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: Data(token.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            guard SecItemUpdate(base(address) as CFDictionary, update as CFDictionary) == errSecSuccess else {
                throw TokenError.unavailable
            }
        } else if status != errSecSuccess { throw TokenError.unavailable }
    }

    static func delete(for address: ServerAddress) throws {
        let status = SecItemDelete(base(address) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenError.unavailable }
    }

    private static func base(_ address: ServerAddress) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: address.credentialScope,
         kSecAttrSynchronizable as String: false]
    }
    enum TokenError: Error, LocalizedError {
        case unavailable
        var errorDescription: String? { "The server token could not be accessed in this device's Keychain." }
    }
}
