/**
 * ============================================================================
 * Production-Ready C++ Backend for DRSSS AI Chatbot
 *
 * Project Authors: Shantanu, Diggaj, Raj, Suraj, and Sanika.
 * Target Deployment: Render (Docker Runtime)
 * Language Standard: Modern C++17 / C++20
 * Dependencies:
 *   - cpp-httplib (single-header HTTP/HTTPS server)
 *   - nlohmann/json (modern JSON for C++)
 *   - libcurl (robust HTTPS network transfer client)
 *   - PostgreSQL libpq (persistent account storage)
 * ============================================================================
 */

#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cctype>
#include <regex>
#include <cstring>
#include <map>
#include <cstdlib>
#include <chrono>
#include <ctime>
#include <memory>
#include <mutex>
#include <thread>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <libpq-fe.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>

// Enable OpenSSL support in httplib if compiled with OpenSSL
#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

using json = nlohmann::json;

// Supported Model Identifiers
static const std::string MODEL_PRIMARY_DEFAULT  = "gemini-3.5-flash-lite"; // DRSSS 3.5 Flash Lite
static const std::string MODEL_PRIMARY_ADVANCED = "gemini-3.6-flash";      // DRSSS 3.6 Flash
static const std::string MODEL_FALLBACK         = "gemini-3.1-flash-lite"; // DRSSS 3.1 Flash Lite

// Structure to hold HTTP response from curl
struct CurlResponse {
    long status_code = 0;
    std::string body;
    std::string error_message;
    bool success = false;
};

// Structure to hold chat completion result
struct ChatResult {
    bool success = false;
    std::string reply;
    std::string model_used;
    std::string thinking_level = "medium";
    bool fallback_used = false;
    std::string error;
};

// libcurl write callback to append received chunks to std::string
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t total_size = size * nmemb;
    std::string* str = static_cast<std::string*>(userp);
    if (str) {
        str->append(static_cast<char*>(contents), total_size);
    }
    return total_size;
}

// Utility: formatted timestamp for production logging
static std::string GetTimestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t now_time = std::chrono::system_clock::to_time_t(now);
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", std::localtime(&now_time));
    return std::string(buf);
}

// Utility: validate model against explicit allowlist
static std::string ValidateModel(const std::string& input) {
    if (input == MODEL_PRIMARY_ADVANCED) {
        return MODEL_PRIMARY_ADVANCED;
    }
    return MODEL_PRIMARY_DEFAULT;
}

// Utility: validate thinking level against supported levels
static std::string ValidateThinkingLevel(const std::string& input) {
    if (input == "high") {
        return "high";
    }
    return "medium";
}

// ---------------------------------------------------------------------------
// Email/password authentication shared with the Express preview server.
// Production accounts are stored in PostgreSQL; passwords use PBKDF2-SHA256.
// ---------------------------------------------------------------------------
static constexpr int AUTH_PBKDF2_ITERATIONS = 600000;
static constexpr int AUTH_DERIVED_BYTES = 32;
static constexpr long long AUTH_SESSION_TTL_MS = 7LL * 24LL * 60LL * 60LL * 1000LL;
static const std::string AUTH_COOKIE_NAME = "drsss_session";
static PGconn* g_auth_db = nullptr;
static bool g_auth_schema_ready = false;
static std::mutex g_auth_db_mutex;

struct AuthUser {
    std::string id;
    std::string name;
    std::string email;
    std::string password_hash;
    std::string salt;
};

static std::string Trim(const std::string& input) {
    const auto first = input.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    const auto last = input.find_last_not_of(" \t\r\n");
    return input.substr(first, last - first + 1);
}

static std::string Lowercase(std::string input) {
    std::transform(input.begin(), input.end(), input.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return input;
}

static std::string JsonStringField(const json& object, const std::string& key) {
    if (!object.is_object() || !object.contains(key) || !object[key].is_string()) return "";
    return object[key].get<std::string>();
}

static std::string HexEncode(const unsigned char* data, size_t length) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < length; ++i) out << std::setw(2) << static_cast<unsigned int>(data[i]);
    return out.str();
}

static bool HexDecode(const std::string& hex, std::vector<unsigned char>& out) {
    if (hex.size() % 2 != 0) return false;
    out.clear();
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        try {
            out.push_back(static_cast<unsigned char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
        } catch (...) { return false; }
    }
    return true;
}

static std::string Base64UrlEncode(const unsigned char* data, size_t length) {
    std::string encoded(4 * ((length + 2) / 3) + 1, '\0');
    const int actual = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(&encoded[0]), data, static_cast<int>(length));
    if (actual < 0) return "";
    encoded.resize(static_cast<size_t>(actual));
    std::replace(encoded.begin(), encoded.end(), '+', '-');
    std::replace(encoded.begin(), encoded.end(), '/', '_');
    while (!encoded.empty() && encoded.back() == '=') encoded.pop_back();
    return encoded;
}

static bool Base64UrlDecode(const std::string& input, std::vector<unsigned char>& output) {
    std::string normalized = input;
    std::replace(normalized.begin(), normalized.end(), '-', '+');
    std::replace(normalized.begin(), normalized.end(), '_', '/');
    while (normalized.size() % 4) normalized.push_back('=');
    output.assign(3 * (normalized.size() / 4) + 3, 0);
    const int decoded = EVP_DecodeBlock(output.data(), reinterpret_cast<const unsigned char*>(normalized.data()), static_cast<int>(normalized.size()));
    if (decoded < 0) return false;
    size_t actual = static_cast<size_t>(decoded);
    if (!normalized.empty() && normalized.back() == '=') --actual;
    if (normalized.size() > 1 && normalized[normalized.size() - 2] == '=') --actual;
    output.resize(actual);
    return true;
}

static std::string HmacSha256Base64Url(const std::string& input, const std::string& secret) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digest_length = 0;
    if (!HMAC(EVP_sha256(), secret.data(), static_cast<int>(secret.size()),
              reinterpret_cast<const unsigned char*>(input.data()), input.size(), digest, &digest_length)) return "";
    return Base64UrlEncode(digest, digest_length);
}

static std::string CreatePasswordHash(const std::string& password, const std::string& salt_hex) {
    std::vector<unsigned char> salt;
    if (!HexDecode(salt_hex, salt) || salt.empty()) return "";
    unsigned char derived[AUTH_DERIVED_BYTES];
    if (PKCS5_PBKDF2_HMAC(password.c_str(), static_cast<int>(password.size()), salt.data(), static_cast<int>(salt.size()),
                          AUTH_PBKDF2_ITERATIONS, EVP_sha256(), AUTH_DERIVED_BYTES, derived) != 1) return "";
    return HexEncode(derived, sizeof(derived));
}

static std::string RandomHex(size_t bytes_count) {
    std::vector<unsigned char> bytes(bytes_count);
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) return "";
    return HexEncode(bytes.data(), bytes.size());
}

static bool EnsureAuthDatabaseUnlocked(std::string& error) {
    const char* database_url = std::getenv("DATABASE_URL");
    if (!database_url || std::string(database_url).empty()) {
        error = "Account sign-in is not configured. Set DATABASE_URL to a persistent PostgreSQL database.";
        return false;
    }
    if (!g_auth_db) {
        g_auth_db = PQconnectdb(database_url);
        if (!g_auth_db || PQstatus(g_auth_db) != CONNECTION_OK) {
            error = g_auth_db ? PQerrorMessage(g_auth_db) : "Could not initialize PostgreSQL connection.";
            if (g_auth_db) { PQfinish(g_auth_db); g_auth_db = nullptr; }
            return false;
        }
    }
    if (!g_auth_schema_ready) {
        PGresult* result = PQexec(g_auth_db,
            "CREATE TABLE IF NOT EXISTS drsss_users ("
            "id TEXT PRIMARY KEY, name VARCHAR(80) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE, "
            "password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
        if (!result || PQresultStatus(result) != PGRES_COMMAND_OK) {
            error = result ? PQresultErrorMessage(result) : PQerrorMessage(g_auth_db);
            if (result) PQclear(result);
            return false;
        }
        PQclear(result);
        g_auth_schema_ready = true;
    }
    return true;
}

static bool QueryUserByEmailUnlocked(const std::string& email, AuthUser& user, std::string& error) {
    if (!EnsureAuthDatabaseUnlocked(error)) return false;
    const char* params[] = { email.c_str() };
    PGresult* result = PQexecParams(g_auth_db,
        "SELECT id, name, email, password_hash, salt FROM drsss_users WHERE email = $1 LIMIT 1",
        1, nullptr, params, nullptr, nullptr, 0);
    if (!result || PQresultStatus(result) != PGRES_TUPLES_OK) {
        error = result ? PQresultErrorMessage(result) : PQerrorMessage(g_auth_db);
        if (result) PQclear(result);
        return false;
    }
    if (PQntuples(result) == 1) {
        user = { PQgetvalue(result, 0, 0), PQgetvalue(result, 0, 1), PQgetvalue(result, 0, 2), PQgetvalue(result, 0, 3), PQgetvalue(result, 0, 4) };
    }
    PQclear(result);
    return true;
}

static bool QueryUserByIdUnlocked(const std::string& id, AuthUser& user, std::string& error) {
    if (!EnsureAuthDatabaseUnlocked(error)) return false;
    const char* params[] = { id.c_str() };
    PGresult* result = PQexecParams(g_auth_db,
        "SELECT id, name, email, password_hash, salt FROM drsss_users WHERE id = $1 LIMIT 1",
        1, nullptr, params, nullptr, nullptr, 0);
    if (!result || PQresultStatus(result) != PGRES_TUPLES_OK) {
        error = result ? PQresultErrorMessage(result) : PQerrorMessage(g_auth_db);
        if (result) PQclear(result);
        return false;
    }
    if (PQntuples(result) == 1) {
        user = { PQgetvalue(result, 0, 0), PQgetvalue(result, 0, 1), PQgetvalue(result, 0, 2), PQgetvalue(result, 0, 3), PQgetvalue(result, 0, 4) };
    }
    PQclear(result);
    return true;
}

static int InsertUserUnlocked(const AuthUser& user, std::string& error) {
    if (!EnsureAuthDatabaseUnlocked(error)) return -1;
    const char* params[] = { user.id.c_str(), user.name.c_str(), user.email.c_str(), user.password_hash.c_str(), user.salt.c_str() };
    PGresult* result = PQexecParams(g_auth_db,
        "INSERT INTO drsss_users (id, name, email, password_hash, salt) VALUES ($1, $2, $3, $4, $5)",
        5, nullptr, params, nullptr, nullptr, 0);
    if (!result || PQresultStatus(result) != PGRES_COMMAND_OK) {
        const char* code = result ? PQresultErrorField(result, PG_DIAG_SQLSTATE) : nullptr;
        error = result ? PQresultErrorMessage(result) : PQerrorMessage(g_auth_db);
        const bool duplicate = code && std::string(code) == "23505";
        if (result) PQclear(result);
        return duplicate ? 0 : -1;
    }
    PQclear(result);
    return 1;
}

static json PublicUser(const AuthUser& user) {
    return json{{"id", user.id}, {"name", user.name}, {"email", user.email}};
}

static std::string CreateSessionToken(const std::string& user_id, const std::string& secret) {
    const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    const std::string payload_json = json{{"sub", user_id}, {"exp", now_ms + AUTH_SESSION_TTL_MS}}.dump();
    const std::string payload = Base64UrlEncode(reinterpret_cast<const unsigned char*>(payload_json.data()), payload_json.size());
    return payload + "." + HmacSha256Base64Url(payload, secret);
}

static std::string CookieValue(const httplib::Request& req, const std::string& name) {
    const std::string header = req.get_header_value("Cookie");
    std::stringstream stream(header);
    std::string part;
    const std::string prefix = name + "=";
    while (std::getline(stream, part, ';')) {
        part = Trim(part);
        if (part.rfind(prefix, 0) == 0) return part.substr(prefix.size());
    }
    return "";
}

static std::string ReadSessionUserId(const httplib::Request& req, const std::string& secret) {
    const std::string token = CookieValue(req, AUTH_COOKIE_NAME);
    const size_t separator = token.find('.');
    if (separator == std::string::npos) return "";
    const std::string payload = token.substr(0, separator);
    const std::string signature = token.substr(separator + 1);
    const std::string expected_signature = HmacSha256Base64Url(payload, secret);
    std::vector<unsigned char> supplied_bytes, expected_bytes;
    if (!Base64UrlDecode(signature, supplied_bytes) || !Base64UrlDecode(expected_signature, expected_bytes) ||
        supplied_bytes.size() != expected_bytes.size() || CRYPTO_memcmp(supplied_bytes.data(), expected_bytes.data(), supplied_bytes.size()) != 0) return "";
    std::vector<unsigned char> payload_bytes;
    if (!Base64UrlDecode(payload, payload_bytes)) return "";
    try {
        const json data = json::parse(std::string(payload_bytes.begin(), payload_bytes.end()));
        if (!data.contains("sub") || !data["sub"].is_string() || !data.contains("exp") || !data["exp"].is_number()) return "";
        if (data["exp"].get<long long>() < std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()) return "";
        return data["sub"].get<std::string>();
    } catch (...) { return ""; }
}

static void SetAuthSessionCookie(const httplib::Request& req, httplib::Response& res, const std::string& user_id, const std::string& secret) {
    std::string cookie = AUTH_COOKIE_NAME + "=" + CreateSessionToken(user_id, secret) + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800";
    if (req.get_header_value("X-Forwarded-Proto") == "https") cookie += "; Secure";
    res.set_header("Set-Cookie", cookie);
}

static void ClearAuthSessionCookie(const httplib::Request& req, httplib::Response& res) {
    std::string cookie = AUTH_COOKIE_NAME + "=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
    if (req.get_header_value("X-Forwarded-Proto") == "https") cookie += "; Secure";
    res.set_header("Set-Cookie", cookie);
}

static bool AuthConfigured(const httplib::Request& req, httplib::Response& res, const std::string& secret) {
    if (secret.size() < 32) {
        res.status = 503;
        res.set_content(json{{"error", "Account sign-in is not configured. Set a SESSION_SECRET with at least 32 characters."}}.dump(), "application/json");
        return false;
    }
    std::string error;
    std::lock_guard<std::mutex> lock(g_auth_db_mutex);
    if (!EnsureAuthDatabaseUnlocked(error)) {
        std::cerr << "[AUTH] Database unavailable: " << error << std::endl;
        res.status = 503;
        res.set_content(json{{"error", "Account sign-in is unavailable. Configure a valid persistent PostgreSQL DATABASE_URL."}}.dump(), "application/json");
        return false;
    }
    return true;
}

struct AuthRateLimitEntry {
    int count = 0;
    std::chrono::steady_clock::time_point reset_at;
};
static std::mutex g_auth_rate_mutex;
static std::map<std::string, AuthRateLimitEntry> g_auth_rate_limits;

static bool IsAuthRateLimited(const httplib::Request& req, const std::string& route) {
    std::string client = req.get_header_value("X-Forwarded-For");
    if (client.empty()) client = req.get_header_value("X-Real-IP");
    if (client.empty()) client = "unknown-client";
    // Use the first forwarded address when the service is behind a trusted proxy.
    const size_t comma = client.find(',');
    if (comma != std::string::npos) client = client.substr(0, comma);
    const std::string key = route + ":" + Trim(client);
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(g_auth_rate_mutex);
    auto& entry = g_auth_rate_limits[key];
    if (entry.count == 0 || entry.reset_at <= now) {
        entry.count = 0;
        entry.reset_at = now + std::chrono::minutes(15);
    }
    ++entry.count;
    return entry.count > 10;
}

/**
 * Execute HTTPS POST request to upstream Gemini REST API using libcurl
 * Strictly authenticates via x-goog-api-key header; never puts key in URL
 */
CurlResponse ExecuteGeminiRequest(const std::string& model, const json& request_payload, const std::string& api_key) {
    CurlResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) {
        resp.error_message = "Failed to initialize libcurl handle";
        return resp;
    }

    // Upstream Generative Language endpoint
    std::string url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    std::string post_data = request_payload.dump();

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");
    // Secure header authentication
    std::string auth_header = "x-goog-api-key: " + api_key;
    headers = curl_slist_append(headers, auth_header.c_str());

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, post_data.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(post_data.length()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);

    // Timeout settings: 45 seconds total, 10 seconds connection
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 45L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);

    // Enforce SSL verification for production security
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        resp.error_message = curl_easy_strerror(res);
        resp.success = false;
    } else {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status_code);
        resp.success = true;
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return resp;
}

/**
 * Parse upstream API JSON response and extract text reply
 */
bool ExtractReplyFromResponse(const std::string& raw_json, std::string& out_text, std::string& out_error_detail) {
    try {
        json j = json::parse(raw_json);

        // Check for top-level API error structure
        if (j.contains("error")) {
            if (j["error"].contains("message")) {
                out_error_detail = j["error"]["message"].get<std::string>();
            } else {
                out_error_detail = "Unknown API error structure";
            }
            return false;
        }

        // Check candidates
        if (j.contains("candidates") && j["candidates"].is_array() && !j["candidates"].empty()) {
            const auto& candidate = j["candidates"][0];
            if (candidate.contains("content") && candidate["content"].contains("parts")) {
                const auto& parts = candidate["content"]["parts"];
                if (parts.is_array() && !parts.empty()) {
                    std::stringstream ss;
                    for (const auto& part : parts) {
                        if (part.contains("text")) {
                            ss << part["text"].get<std::string>();
                        }
                    }
                    out_text = ss.str();
                    return !out_text.empty();
                }
            }
        }

        out_error_detail = "Empty response candidate from model";
        return false;
    } catch (const std::exception& e) {
        out_error_detail = std::string("JSON parsing exception: ") + e.what();
        return false;
    }
}

// Redact credentials and keep upstream diagnostics short enough for safe logs/UI.
static std::string SanitizeUpstreamDiagnostic(std::string message) {
    try {
        message = std::regex_replace(message, std::regex(R"(AIza[0-9A-Za-z_-]{20,})"), "[REDACTED]");
        message = std::regex_replace(message, std::regex(R"((api[_-]?key|key)\s*[:=]\s*[^,\s\"}]+)", std::regex::icase), "$1=[REDACTED]");
    } catch (...) {
        // Keep the original diagnostic if a regex engine unexpectedly fails.
    }
    if (message.size() > 500) message.resize(500);
    return message;
}

// Return the real HTTP/network reason instead of silently dropping non-200 API errors.
static std::string DescribeUpstreamFailure(const CurlResponse& response) {
    if (!response.success) {
        return SanitizeUpstreamDiagnostic("Network transport error: " + response.error_message);
    }

    try {
        const json body = json::parse(response.body);
        if (body.contains("error") && body["error"].is_object()) {
            std::string message = "HTTP " + std::to_string(response.status_code);
            if (body["error"].contains("status") && body["error"]["status"].is_string()) {
                message += " (" + body["error"]["status"].get<std::string>() + ")";
            }
            if (body["error"].contains("message") && body["error"]["message"].is_string()) {
                message += ": " + body["error"]["message"].get<std::string>();
            }
            return SanitizeUpstreamDiagnostic(message);
        }
    } catch (...) {
        // If the provider did not return JSON, report status without echoing a potentially large body.
    }

    std::string text, parse_error;
    if (response.status_code == 200) {
        ExtractReplyFromResponse(response.body, text, parse_error);
        if (!parse_error.empty()) {
            return SanitizeUpstreamDiagnostic("HTTP 200 but no usable answer was returned: " + parse_error);
        }
        return "HTTP 200 but no usable answer was returned";
    }
    return "HTTP " + std::to_string(response.status_code) + " with no readable upstream error message";
}

/**
 * Check if the returned HTTP status code or error qualifies for failover retry
 * (Rate Limit 429, Quota exhaustion, 5xx server errors, or curl transport failures)
 */
bool ShouldFailover(long status_code, bool curl_success) {
    if (!curl_success) return true;
    if (status_code == 429) return true; // Rate limit / Quota exceeded
    if (status_code >= 500 && status_code <= 599) return true; // Server errors (500, 502, 503, 504)
    if (status_code == 404) return true; // Model not found in this region
    return false;
}

/**
 * Process chat query with model selection, thinking configuration,
 * bounded retries, and automatic failover
 */
ChatResult GenerateChatResponse(
    const json& incoming_history,
    const std::string& user_message,
    const std::string& api_key,
    const std::string& requested_model = MODEL_PRIMARY_DEFAULT,
    const std::string& requested_thinking = "medium"
) {
    ChatResult result;
    std::string primary_model = ValidateModel(requested_model);
    std::string thinking_level = ValidateThinkingLevel(requested_thinking);

    result.thinking_level = thinking_level;

    // Build the contents array conforming to REST specifications
    json contents = json::array();

    // Append conversation history
    if (incoming_history.is_array()) {
        for (const auto& item : incoming_history) {
            if (item.is_object() && item.contains("role") && item.contains("parts")) {
                std::string role = item["role"].get<std::string>();
                if (role == "assistant") role = "model";
                contents.push_back({
                    {"role", role},
                    {"parts", item["parts"]}
                });
            } else if (item.is_object() && item.contains("role") && item.contains("content")) {
                std::string role = item["role"].get<std::string>();
                if (role == "assistant") role = "model";
                std::string text = item["content"].get<std::string>();
                contents.push_back({
                    {"role", role},
                    {"parts", json::array({{{"text", text}}})}
                });
            }
        }
    }

    // Append the new user prompt
    contents.push_back({
        {"role", "user"},
        {"parts", json::array({{{"text", user_message}}})}
    });

    // Build payload with thinkingConfig
    json gemini_payload = {
        {"contents", contents},
        {"generationConfig", {
            {"temperature", 0.7},
            {"topP", 0.95},
            {"topK", 40},
            {"maxOutputTokens", 4096},
            {"thinkingConfig", {
                {"thinkingLevel", thinking_level}
            }}
        }},
        {"systemInstruction", {
            {"parts", json::array({{
                {"text", "You are an intelligent, helpful, and concise AI assistant named DRSSS AI. "
                         "You provide well-structured, clear Markdown answers with syntax-highlighted code when applicable. "
                         "Credit: Designed and built by Shantanu, Diggaj, Raj, Suraj, and Sanika."}
            }})}
        }}
    };

    // 1. Attempt Primary Model
    std::cout << "[" << GetTimestamp() << "] [INFO] Attempting primary model: " << primary_model
              << " with thinking level: " << thinking_level << std::endl;
    CurlResponse primary_res = ExecuteGeminiRequest(primary_model, gemini_payload, api_key);

    std::string reply_text;
    std::string error_detail;

    if (primary_res.success && primary_res.status_code == 200) {
        if (ExtractReplyFromResponse(primary_res.body, reply_text, error_detail)) {
            result.success = true;
            result.reply = reply_text;
            result.model_used = primary_model;
            result.fallback_used = false;
            std::cout << "[" << GetTimestamp() << "] [SUCCESS] Completed with primary model: " << primary_model << std::endl;
            return result;
        }
    }

    // Check if retryable failure
    bool is_retryable = ShouldFailover(primary_res.status_code, primary_res.success);
    if (is_retryable) {
        std::cerr << "[" << GetTimestamp() << "] [RETRY] Primary model " << primary_model
                  << " failed (Status: " << primary_res.status_code << "). Retrying once after 500ms..." << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        primary_res = ExecuteGeminiRequest(primary_model, gemini_payload, api_key);

        if (primary_res.success && primary_res.status_code == 200) {
            if (ExtractReplyFromResponse(primary_res.body, reply_text, error_detail)) {
                result.success = true;
                result.reply = reply_text;
                result.model_used = primary_model;
                result.fallback_used = false;
                std::cout << "[" << GetTimestamp() << "] [SUCCESS] Primary retry succeeded: " << primary_model << std::endl;
                return result;
            }
        }
    }

    // 2. Failover to Fallback Model: gemini-3.1-flash-lite
    std::cerr << "[" << GetTimestamp() << "] [FAILOVER TRIGGERED] Primary model " << primary_model
              << " unavailable. Switching to fallback model: " << MODEL_FALLBACK << std::endl;

    CurlResponse fallback_res = ExecuteGeminiRequest(MODEL_FALLBACK, gemini_payload, api_key);

    if (fallback_res.success && fallback_res.status_code == 200) {
        if (ExtractReplyFromResponse(fallback_res.body, reply_text, error_detail)) {
            result.success = true;
            result.reply = reply_text;
            result.model_used = MODEL_FALLBACK;
            result.fallback_used = true;
            std::cout << "[" << GetTimestamp() << "] [SUCCESS] Failover successful with fallback model: " << MODEL_FALLBACK << std::endl;
            return result;
        }
    }

    // If both models failed, preserve the actual provider status and reason.
    // Previously, non-200 HTTP responses left error_detail empty, hiding the cause
    // (invalid API key, quota, model access, invalid request, etc.) from Render logs.
    result.success = false;
    const std::string primary_error = DescribeUpstreamFailure(primary_res);
    const std::string fallback_error = DescribeUpstreamFailure(fallback_res);
    std::cerr << "[" << GetTimestamp() << "] [UPSTREAM ERROR] Primary model "
              << primary_model << ": " << primary_error << std::endl;
    std::cerr << "[" << GetTimestamp() << "] [UPSTREAM ERROR] Fallback model "
              << MODEL_FALLBACK << ": " << fallback_error << std::endl;
    result.error = "Both primary (" + primary_model + ") and fallback (" + MODEL_FALLBACK +
                   ") models failed. Primary reason: " + primary_error +
                   ". Fallback reason: " + fallback_error;
    result.error = SanitizeUpstreamDiagnostic(result.error);
    std::cerr << "[" << GetTimestamp() << "] [ERROR] " << result.error << std::endl;
    return result;
}

int main(int argc, char* argv[]) {
    // Initialize global libcurl environment
    curl_global_init(CURL_GLOBAL_DEFAULT);

    // Read PORT dynamically from environment or default to 10000 (Render default)
    int port = 10000;
    const char* env_port = std::getenv("PORT");
    if (env_port && std::strlen(env_port) > 0) {
        try {
            port = std::stoi(env_port);
        } catch (...) {
            port = 10000;
        }
    }

    // Read GEMINI_API_KEY strictly from environment variable
    const char* env_key = std::getenv("GEMINI_API_KEY");
    std::string api_key = (env_key != nullptr) ? std::string(env_key) : "";

    std::cout << "==========================================================" << std::endl;
    std::cout << " DRSSS AI C++ Full-Stack Backend" << std::endl;
    std::cout << " Built by Shantanu, Diggaj, Raj, Suraj, and Sanika" << std::endl;
    std::cout << " Primary Default  : " << MODEL_PRIMARY_DEFAULT << " (DRSSS 3.5 Flash Lite)" << std::endl;
    std::cout << " Primary Advanced : " << MODEL_PRIMARY_ADVANCED << " (DRSSS 3.6 Flash)" << std::endl;
    std::cout << " Fallback Model   : " << MODEL_FALLBACK << " (DRSSS 3.1 Flash Lite)" << std::endl;
    std::cout << " Server Port      : " << port << std::endl;
    if (api_key.empty()) {
        std::cerr << " [WARNING] GEMINI_API_KEY environment variable is NOT set!" << std::endl;
        std::cerr << "           Please configure GEMINI_API_KEY before making chat calls." << std::endl;
    } else {
        std::cout << " API Key          : Configured (length: " << api_key.length() << ")" << std::endl;
    }
    std::cout << " Account Auth     : " << ((std::getenv("DATABASE_URL") && std::getenv("SESSION_SECRET")) ? "Configured" : "Requires DATABASE_URL and SESSION_SECRET") << std::endl;
    std::cout << "==========================================================" << std::endl;

    httplib::Server svr;

    // Helper: set standard CORS and JSON headers
    auto set_cors_headers = [](httplib::Response& res) {
        res.set_header("Access-Control-Allow-Origin", "*");
        res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    };

    // Pre-routing CORS handler
    svr.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
        if (req.method == "OPTIONS") {
            set_cors_headers(res);
            res.status = 204;
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // 1. Health check endpoint: GET /api/health
    svr.Get("/api/health", [&](const httplib::Request&, httplib::Response& res) {
        set_cors_headers(res);
        json health_res = {
            {"status", "ok"},
            {"service", "drsss-cpp-backend"},
            {"models", {
                {"primary_default", MODEL_PRIMARY_DEFAULT},
                {"primary_advanced", MODEL_PRIMARY_ADVANCED},
                {"fallback", MODEL_FALLBACK}
            }},
            {"thinking_levels", json::array({"medium", "high"})},
            {"credits", "Built by Shantanu, Diggaj, Raj, Suraj, and Sanika"}
        };
        res.set_content(health_res.dump(), "application/json");
    });

    // 2. Register a user with a PBKDF2 password hash and persistent PostgreSQL storage.
    svr.Post("/api/auth/register", [&](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        if (IsAuthRateLimited(req, "register")) {
            res.status = 429;
            res.set_content(json{{"error", "Too many attempts. Please wait a few minutes and try again."}}.dump(), "application/json");
            return;
        }
        const char* secret_env = std::getenv("SESSION_SECRET");
        const std::string session_secret = secret_env ? std::string(secret_env) : "";
        if (!AuthConfigured(req, res, session_secret)) return;

        json body;
        try { body = json::parse(req.body); }
        catch (...) {
            res.status = 400;
            res.set_content(json{{"error", "Invalid request body."}}.dump(), "application/json");
            return;
        }
        std::string name = JsonStringField(body, "name");
        std::string email = Lowercase(Trim(JsonStringField(body, "email")));
        std::string password = JsonStringField(body, "password");
        name = Trim(name);
        static const std::regex email_pattern(R"(^[^\s@]+@[^\s@]+\.[^\s@]+$)");
        if (name.empty() || name.size() > 80) {
            res.status = 400;
            res.set_content(json{{"error", "Enter a name between 1 and 80 characters."}}.dump(), "application/json");
            return;
        }
        if (email.size() > 254 || !std::regex_match(email, email_pattern)) {
            res.status = 400;
            res.set_content(json{{"error", "Enter a valid email address."}}.dump(), "application/json");
            return;
        }
        if (password.size() < 8 || password.size() > 128) {
            res.status = 400;
            res.set_content(json{{"error", "Password must be between 8 and 128 characters."}}.dump(), "application/json");
            return;
        }

        AuthUser existing;
        std::string db_error;
        std::string salt = RandomHex(16);
        AuthUser user{RandomHex(16), name, email, CreatePasswordHash(password, salt), salt};
        if (salt.empty() || user.id.empty() || user.password_hash.empty()) {
            res.status = 500;
            res.set_content(json{{"error", "Could not securely prepare the account. Please try again."}}.dump(), "application/json");
            return;
        }
        int inserted = -1;
        {
            std::lock_guard<std::mutex> lock(g_auth_db_mutex);
            if (!QueryUserByEmailUnlocked(email, existing, db_error)) {
                std::cerr << "[AUTH] Registration lookup failed: " << db_error << std::endl;
                res.status = 503;
                res.set_content(json{{"error", "Account storage is temporarily unavailable."}}.dump(), "application/json");
                return;
            }
            if (!existing.id.empty()) {
                res.status = 409;
                res.set_content(json{{"error", "An account with this email already exists. Try signing in."}}.dump(), "application/json");
                return;
            }
            inserted = InsertUserUnlocked(user, db_error);
        }
        if (inserted == 0) {
            res.status = 409;
            res.set_content(json{{"error", "An account with this email already exists. Try signing in."}}.dump(), "application/json");
            return;
        }
        if (inserted < 0) {
            std::cerr << "[AUTH] Account creation failed: " << db_error << std::endl;
            res.status = 500;
            res.set_content(json{{"error", "Account creation failed. Please try again."}}.dump(), "application/json");
            return;
        }
        SetAuthSessionCookie(req, res, user.id, session_secret);
        res.status = 201;
        res.set_content(json{{"user", PublicUser(user)}}.dump(), "application/json");
    });

    // 3. Log in by verifying the password hash with a constant-time comparison.
    svr.Post("/api/auth/login", [&](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        if (IsAuthRateLimited(req, "login")) {
            res.status = 429;
            res.set_content(json{{"error", "Too many attempts. Please wait a few minutes and try again."}}.dump(), "application/json");
            return;
        }
        const char* secret_env = std::getenv("SESSION_SECRET");
        const std::string session_secret = secret_env ? std::string(secret_env) : "";
        if (!AuthConfigured(req, res, session_secret)) return;

        json body;
        try { body = json::parse(req.body); }
        catch (...) {
            res.status = 400;
            res.set_content(json{{"error", "Invalid request body."}}.dump(), "application/json");
            return;
        }
        const std::string email = Lowercase(Trim(JsonStringField(body, "email")));
        const std::string password = JsonStringField(body, "password");
        if (email.empty() || password.empty() || email.size() > 254 || password.size() > 128) {
            res.status = 400;
            res.set_content(json{{"error", "Enter your email and password."}}.dump(), "application/json");
            return;
        }

        AuthUser user;
        std::string db_error;
        {
            std::lock_guard<std::mutex> lock(g_auth_db_mutex);
            if (!QueryUserByEmailUnlocked(email, user, db_error)) {
                std::cerr << "[AUTH] Login lookup failed: " << db_error << std::endl;
                res.status = 503;
                res.set_content(json{{"error", "Account storage is temporarily unavailable."}}.dump(), "application/json");
                return;
            }
        }
        if (user.id.empty()) {
            (void)CreatePasswordHash(password, "64727373732d617574682d64756d6d79");
            res.status = 401;
            res.set_content(json{{"error", "Invalid email or password."}}.dump(), "application/json");
            return;
        }
        const std::string calculated = CreatePasswordHash(password, user.salt);
        std::vector<unsigned char> supplied_hash, stored_hash;
        const bool hash_valid = HexDecode(calculated, supplied_hash) && HexDecode(user.password_hash, stored_hash) &&
            supplied_hash.size() == stored_hash.size() && CRYPTO_memcmp(supplied_hash.data(), stored_hash.data(), supplied_hash.size()) == 0;
        if (!hash_valid) {
            res.status = 401;
            res.set_content(json{{"error", "Invalid email or password."}}.dump(), "application/json");
            return;
        }
        SetAuthSessionCookie(req, res, user.id, session_secret);
        res.set_content(json{{"user", PublicUser(user)}}.dump(), "application/json");
    });

    // 4. Restore the current server-validated session.
    svr.Get("/api/auth/me", [&](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        const char* secret_env = std::getenv("SESSION_SECRET");
        const std::string session_secret = secret_env ? std::string(secret_env) : "";
        if (!AuthConfigured(req, res, session_secret)) return;
        const std::string user_id = ReadSessionUserId(req, session_secret);
        if (user_id.empty()) {
            res.status = 401;
            res.set_content(json{{"error", "Not signed in."}}.dump(), "application/json");
            return;
        }
        AuthUser user;
        std::string db_error;
        {
            std::lock_guard<std::mutex> lock(g_auth_db_mutex);
            if (!QueryUserByIdUnlocked(user_id, user, db_error)) {
                std::cerr << "[AUTH] Session lookup failed: " << db_error << std::endl;
                res.status = 503;
                res.set_content(json{{"error", "Account storage is temporarily unavailable."}}.dump(), "application/json");
                return;
            }
        }
        if (user.id.empty()) {
            ClearAuthSessionCookie(req, res);
            res.status = 401;
            res.set_content(json{{"error", "Session is no longer valid."}}.dump(), "application/json");
            return;
        }
        res.set_content(json{{"user", PublicUser(user)}}.dump(), "application/json");
    });

    // 5. Clear the HttpOnly session cookie on logout.
    svr.Post("/api/auth/logout", [&](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);
        ClearAuthSessionCookie(req, res);
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    });

    // 6. Chat completion endpoint: POST /api/chat
    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        set_cors_headers(res);

        // Verify API key configuration
        const char* current_env_key = std::getenv("GEMINI_API_KEY");
        std::string current_key = (current_env_key != nullptr) ? std::string(current_env_key) : api_key;

        if (current_key.empty()) {
            json err = {
                {"error", "GEMINI_API_KEY is not configured on the server. Please set the GEMINI_API_KEY environment variable."}
            };
            res.status = 500;
            res.set_content(err.dump(), "application/json");
            return;
        }

        // Parse incoming JSON body
        json body;
        try {
            body = json::parse(req.body);
        } catch (const std::exception& e) {
            json err = {{"error", "Invalid JSON body: " + std::string(e.what())}};
            res.status = 400;
            res.set_content(err.dump(), "application/json");
            return;
        }

        if (!body.contains("message") || !body["message"].is_string()) {
            json err = {{"error", "Missing or invalid 'message' string field in request body."}};
            res.status = 400;
            res.set_content(err.dump(), "application/json");
            return;
        }

        std::string message = body["message"].get<std::string>();
        json history = body.value("history", json::array());
        std::string model = body.value("model", MODEL_PRIMARY_DEFAULT);
        std::string thinking_level = body.value("thinking_level", "medium");

        // Process query with model routing, thinking configuration, and failover
        ChatResult result = GenerateChatResponse(history, message, current_key, model, thinking_level);

        if (result.success) {
            json success_res = {
                {"reply", result.reply},
                {"model_used", result.model_used},
                {"thinking_level", result.thinking_level},
                {"fallback_used", result.fallback_used}
            };
            res.status = 200;
            res.set_content(success_res.dump(), "application/json");
        } else {
            json failure_res = {
                {"error", result.error},
                {"model_attempted", model + " -> " + MODEL_FALLBACK}
            };
            res.status = 502; // Bad Gateway / Upstream failure
            res.set_content(failure_res.dump(), "application/json");
        }
    });

    // 4. Static file server: serve frontend directory
    bool mount_success = svr.set_mount_point("/", "./frontend");
    if (!mount_success) {
        std::cerr << "[" << GetTimestamp() << "] [WARN] Failed to mount ./frontend directory. Checking current working directory." << std::endl;
    } else {
        std::cout << "[" << GetTimestamp() << "] [INFO] Mounted static directory ./frontend at /" << std::endl;
    }

    std::cout << "[" << GetTimestamp() << "] [READY] DRSSS AI Server listening on 0.0.0.0:" << port << std::endl;
    svr.listen("0.0.0.0", port);

    // Clean up libcurl
    curl_global_cleanup();
    return 0;
}
