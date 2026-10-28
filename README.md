# DRSSS AI - Intelligent Conversational Engine

A production-ready, full-stack AI Chatbot web application designed for seamless deployment on **Render** using **Docker**, featuring dark-mode conversational UI and branded exclusively as **DRSSS AI**. The backend is written in modern **C++ (C++17/20)**, while the frontend is constructed using pure vanilla **HTML5**, modern **CSS3**, and **JavaScript (ES6+)**.

> **Project Credits**: Designed and built by **Shantanu, Diggaj, Raj, Suraj, and Sanika.**

---

## Architecture Overview

```
                      +---------------------------------------+
                      |           Render Deployment           |
                      |   (Docker Multi-Stage Container)      |
                      +---------------------------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
      +-------------------+                               +--------------------+
      |   C++ Backend     |                               | Vanilla Frontend   |
      | (backend/main.cpp)|                               | (frontend/)        |
      +-------------------+                               +--------------------+
      | - cpp-httplib     |                               | - HTML5 & CSS3     |
      | - nlohmann/json   |                               | - JavaScript (ES6+)|
      | - libcurl HTTPS   |                               | - Email/password auth |
      | - x-goog-api-key  |                               | - Marked.js / hljs |
      | - libpq/Postgres  |                               | - local guest mode |
      +-------------------+                               +--------------------+
                |
                +---------------------------------------+
                |                                       |
                v                                       v
   +---------------------------+           +---------------------------+
   | Primary Option 1          |           | Primary Option 2          |
   | DRSSS 3.5 Flash Lite      |           | DRSSS 3.6 Flash           |
   | (gemini-3.5-flash-lite)   |           | (gemini-3.6-flash)        |
   +---------------------------+           +---------------------------+
                \                                       /
                 \-----[ On HTTP 429 / 5xx Failover ]--/
                                   |
                                   v
                      +---------------------------+
                      | Shared Automatic Fallback |
                      | DRSSS 3.1 Flash Lite      |
                      | (gemini-3.1-flash-lite)   |
                      +---------------------------+
```

---

## Core Features

1. **Independent Model Switching**:
   - **DRSSS 3.5 Flash Lite** (`gemini-3.5-flash-lite`): Fast and efficient for everyday questions, summaries, and routine tasks. Default for new sessions.
   - **DRSSS 3.6 Flash** (`gemini-3.6-flash`): Advanced performance for complex coding, multi-step problem solving, and demanding technical reasoning.
   - Persisted across page refreshes; seamlessly switches without losing conversation history.

2. **Independent Thinking-Level Selector**:
   - **Standard** (`thinkingLevel: "medium"`): Balanced responses for everyday use.
   - **Extended** (`thinkingLevel: "high"`): Deep reasoning for complex problems, debugging, and algorithms.

3. **High-Performance C++ Backend (`backend/main.cpp`)**:
   - Single-header multi-threaded HTTP/HTTPS serving via `cpp-httplib`.
   - Fast, type-safe JSON parsing with `nlohmann/json`.
   - Robust HTTPS transfers with `libcurl` and SSL certificate verification.
   - Header-based authentication (`x-goog-api-key`); API keys are never exposed in query URLs or frontend scripts.
   - Bounded retries and automatic failover to **DRSSS 3.1 Flash Lite** (`gemini-3.1-flash-lite`) on HTTP 429 (rate-limit/quota) or 5xx server errors.
   - Dynamically binds to `$PORT` (defaults to 10000 on Render).
   - Serves static assets from `./frontend` via `svr.set_mount_point("/", "./frontend");`.

4. **Clean Session & State Management**:
   - Prunes phantom/empty drafts: new conversations are only persisted once the first prompt is sent.
   - Multi-session chat history organized cleanly in `localStorage` per user account.
   - Clean deletion and selection synchronization.

5. **Email and Password Accounts**:
   - Account creation and sign-in backed by PostgreSQL in production.
   - Passwords stored as PBKDF2-HMAC-SHA256 hashes, never plaintext.
   - Signed, HttpOnly, SameSite session cookies with a seven-day expiry.
   - Guest mode remains available; local guest chat history is not deleted when signing in.

---

## Repository Structure

```
├── backend/
│   └── main.cpp           # Modern C++ server with cpp-httplib, nlohmann/json, libcurl failover
├── frontend/
│   ├── index.html         # Semantic HTML5 layout with account forms, Marked, and Highlight.js CDNs
│   ├── style.css          # Modern dark CSS3 styling with glassmorphism and ambient gradients
│   └── script.js          # Pure ES6+ app logic, model selection, reasoning controls, and history
├── src/utils/
│   ├── gemini-failover.ts      # Pure TypeScript logic for payload building and failover
│   └── gemini-failover.test.ts # Fast-feedback unit tests via node:test (13/13 passing)
├── CMakeLists.txt         # CMake build configuration with FetchContent
├── Dockerfile             # Multi-stage Docker build for Ubuntu 24.04 LTS (GCC 13 & GLIBCXX_3.4.32)
├── render.yaml            # Render Blueprint configuration
├── server.ts              # Express dev/preview server matching C++ endpoints for live preview
└── README.md              # Project documentation
```

---

## Deployment on Render

This project includes a turnkey `render.yaml` Blueprint specification.

### 1. Environment Variables in Render
Configure these in your Render service's **Environment** tab:

| Variable | Description | Required? |
|---|---|---|
| `GEMINI_API_KEY` | Upstream AI API key for DRSSS inference | **Required for chat** |
| `DATABASE_URL` | PostgreSQL connection string for persistent accounts | **Required for account creation/login** |
| `SESSION_SECRET` | Long random secret used to sign session cookies | **Required for account creation/login** |
| `PORT` | HTTP server port (Render injects it automatically) | Auto |

Create a PostgreSQL database and use its connection string as `DATABASE_URL`. Prefer the internal connection string when the database and web service are in the same Render region. For an external PostgreSQL URL that requires TLS, include `sslmode=require` in the connection string. Generate a strong secret for `SESSION_SECRET` (for example, `openssl rand -hex 32`, yielding 64 characters); never put it in frontend code or commit it.

The backend creates the `drsss_users` table automatically on the first authentication request. It stores account records in PostgreSQL and never stores plaintext passwords. Account endpoints return a configuration error until both `DATABASE_URL` and `SESSION_SECRET` are configured. `GOOGLE_CLIENT_ID` and Google OAuth are no longer used.

In local Node preview (`npm run dev`), authentication uses `.data/auth-users.json` if `DATABASE_URL` is not set. This fallback is only for development/preview; production must use PostgreSQL because container filesystems may be ephemeral.

---

## Local Development & Testing

### Node.js Dev Server (Vite + Express):
```bash
npm install
npm test       # Runs the 13 unit tests for failover and model routing
npm run dev    # Starts server on http://localhost:3000
```

### Native C++ Build:
```bash
mkdir build && cd build
cmake ..
make -j$(nproc)
PORT=10000 ./gemini_chatbot_server
```

### Docker Build:
```bash
docker build -t drsss-ai-fullstack .
docker run -p 10000:10000 \
  -e GEMINI_API_KEY="your-api-key" \
  -e DATABASE_URL="your-postgresql-connection-string" \
  -e SESSION_SECRET="a-long-random-secret" \
  drsss-ai-fullstack
```
