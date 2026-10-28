# ==============================================================================
# Production Dockerfile for Gemini C++ Chatbot Backend & Vanilla Frontend
# Designed for Render Deployment
# Built by Shantanu, Diggaj, Raj, Suraj, and Sanika.
# ==============================================================================

# --- Stage 1: Build Environment (Ubuntu 24.04 LTS / GCC 13 / CMake) ---
FROM ubuntu:24.04 AS builder

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install modern GCC 13 compiler toolchain, CMake, Git, libcurl dev headers, OpenSSL dev headers, and CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    make \
    libcurl4-openssl-dev \
    libssl-dev \
    libpq-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy CMake configuration and C++ source code
COPY CMakeLists.txt ./
COPY backend/ ./backend/

# Configure and compile in Release mode using all available CPU cores
RUN mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    cmake --build . --config Release -j$(nproc)

# --- Stage 2: Minimal Production Runtime Image (Ubuntu 24.04 LTS with GLIBCXX_3.4.32) ---
FROM ubuntu:24.04 AS runner

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies (libcurl, OpenSSL 3, CA certificates, and libstdc++6 with GLIBCXX_3.4.32)
RUN apt-get update && \
    (apt-get install -y --no-install-recommends ca-certificates libcurl4 libssl3t64 libstdc++6 libpq5 || \
     apt-get install -y --no-install-recommends ca-certificates libcurl4 libssl3 libstdc++6 libpq5) && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root system user for production process security
RUN if id -u appuser >/dev/null 2>&1; then \
        echo "appuser already exists"; \
    else \
        useradd -m -s /bin/bash appuser; \
    fi

# Copy compiled C++ binary from builder stage
COPY --from=builder /app/build/gemini_server /app/gemini_server

# Copy static frontend assets (index.html, style.css, script.js)
COPY frontend/ /app/frontend/

# Adjust file ownership
RUN chown -R appuser:appuser /app && chmod +x /app/gemini_server

# Switch to unprivileged user
USER appuser

# Default port exposed by Render
EXPOSE 10000

# Environment variables
ENV PORT=10000

# Run the C++ server executable
CMD ["/app/gemini_server"]
