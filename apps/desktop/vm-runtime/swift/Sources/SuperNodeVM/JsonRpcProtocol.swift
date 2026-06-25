import Foundation

// JSON-RPC 2.0 protocol types for stdin/stdout communication.
//
// Request:  {"jsonrpc":"2.0","id":1,"method":"start","params":{...}}
// Response: {"jsonrpc":"2.0","id":1,"result":{...}}
// Error:    {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
// Event:    {"jsonrpc":"2.0","method":"event","params":{...}}  (no id = notification)

/// JSON-RPC 2.0 request object.
struct JsonRpcRequest: Codable {
    let jsonrpc: String
    let id: Int?
    let method: String
    let params: JsonRpcValue?

    init(id: Int?, method: String, params: JsonRpcValue? = nil) {
        self.jsonrpc = "2.0"
        self.id = id
        self.method = method
        self.params = params
    }
}

/// JSON-RPC 2.0 response object (result).
struct JsonRpcResponse: Codable {
    let jsonrpc: String
    let id: Int?
    let result: JsonRpcValue?
    let error: JsonRpcError?

    init(id: Int?, result: JsonRpcValue) {
        self.jsonrpc = "2.0"
        self.id = id
        self.result = result
        self.error = nil
    }

    init(id: Int?, error: JsonRpcError) {
        self.jsonrpc = "2.0"
        self.id = id
        self.result = nil
        self.error = error
    }

    /// Create a response preserving whatever was set by the forwarding layer.
    init(id: Int?, result: JsonRpcValue?, error: JsonRpcError?) {
        self.jsonrpc = "2.0"
        self.id = id
        self.result = result
        self.error = error
    }
}

/// JSON-RPC 2.0 error object.
struct JsonRpcError: Codable {
    let code: Int
    let message: String
    let data: JsonRpcValue?

    init(code: Int, message: String, data: JsonRpcValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

/// JSON-RPC 2.0 notification (event without id).
struct JsonRpcEvent: Codable {
    let jsonrpc: String
    let method: String
    let params: JsonRpcValue

    init(method: String, params: JsonRpcValue) {
        self.jsonrpc = "2.0"
        self.method = method
        self.params = params
    }
}

/// Flexible JSON value type for params/result/error data.
/// Encodes/decodes any valid JSON structure without requiring a fixed schema.
enum JsonRpcValue: Codable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null
    case array([JsonRpcValue])
    case dictionary([String: JsonRpcValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .boolean(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JsonRpcValue].self) {
            self = .array(array)
        } else if let dictionary = try? container.decode([String: JsonRpcValue].self) {
            self = .dictionary(dictionary)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "JsonRpcValue cannot decode value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .boolean(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        case .array(let value):
            try container.encode(value)
        case .dictionary(let value):
            try container.encode(value)
        }
    }
}

// ─── Convenience helpers for constructing responses ───

extension JsonRpcValue {
    /// Access the underlying string value, or nil if not a string.
    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Access the underlying number value, or nil if not a number.
    var numberValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    /// Access the underlying dictionary value, or nil if not a dictionary.
    var dictionaryValue: [String: JsonRpcValue]? {
        if case .dictionary(let d) = self { return d }
        return nil
    }
}
