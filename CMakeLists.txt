cmake_minimum_required(VERSION 3.16)
project(gemini_cpp_chatbot CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Fetch nlohmann/json (single header JSON for modern C++)
include(FetchContent)
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
)
FetchContent_MakeAvailable(nlohmann_json)

# Fetch cpp-httplib (header-only HTTP/HTTPS server)
FetchContent_Declare(
    httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG v0.15.3
)
FetchContent_MakeAvailable(httplib)

# Find system libraries: libcurl, OpenSSL, pthreads
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
find_package(PostgreSQL REQUIRED)

add_executable(gemini_server backend/main.cpp)

target_link_libraries(gemini_server PRIVATE
    nlohmann_json::nlohmann_json
    httplib::httplib
    CURL::libcurl
    OpenSSL::SSL
    OpenSSL::Crypto
    Threads::Threads
    PostgreSQL::PostgreSQL
)

target_compile_definitions(gemini_server PRIVATE
    CPPHTTPLIB_OPENSSL_SUPPORT
)
