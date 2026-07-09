import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import session from "express-session";
import createMemoryStore from "memorystore";
import crypto from "node:crypto";
import { registerRoutes } from "./routes";
import { registerAuthRoutes } from "./auth";
import { serveStatic } from "./static";
import { initStorage } from "./storage";
import { createServer } from "node:http";

// A missing SESSION_SECRET must never crash the whole server (that took the entire
// app down with 503s on every route, including login/report/WhatsApp, in production).
// Instead, auto-generate a strong random secret at boot when one isn't supplied via
// env vars. This still avoids the old predictable-fallback risk (a fresh random value
// each boot cannot be guessed or reused by an attacker) while keeping the app online.
// Set SESSION_SECRET explicitly in the deployment environment for sessions that persist
// across server restarts; otherwise all sessions are invalidated on every restart.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "WARNING: SESSION_SECRET environment variable not set — generated a random secret for this process. " +
    "Sessions will be invalidated on every server restart. Set SESSION_SECRET explicitly for persistent sessions."
  );
}

// Surface any crash reason instead of dying silently (which the platform reports
// simply as "No service is running on port <port>" with zero diagnostic info).
process.on("uncaughtException", (err) => {
  console.error("FATAL uncaughtException (server did not start or crashed):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("FATAL unhandledRejection (server did not start or crashed):", reason);
});

const app = express();
app.set("trust proxy", 1); // required so secure cookies work correctly behind Render/pplx.app's HTTPS-terminating reverse proxy
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ─── Session middleware (in-memory store — no native module) ────────────────
// Uses `memorystore`, a pure-JS session store with TTL-based pruning. This
// replaces the previous `better-sqlite3`-backed store, which pulled in a native
// C++ addon that must be compiled/loaded at install/startup. If that native
// build failed in a deployment sandbox (prebuilt binary download blocked, or
// node-gyp toolchain unavailable), the server process would never start —
// reported by the platform simply as "No service is running on port 5000".
// Trade-off: sessions live in process memory and are cleared on restart, so
// users re-authenticate after a redeploy (already the effective behaviour when
// SESSION_SECRET is unset, as noted above).
const MemoryStore = createMemoryStore(session);
app.use(session({
  name: "__Host-ntgs_session",   // __Host- prefix required so pplx.app's proxy doesn't strip the cookie
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: 15 * 60 * 1000 }),
  // credentials:"include" on every fetch means the browser always sends this cookie.
  // SameSite=lax works fine here — the session cookie travels with every request.
  // NOTE: __Host- prefixed cookies require Secure=true and Path="/" with no Domain attribute — always set cookie.secure true regardless of NODE_ENV so it still works when proxied over HTTPS in preview/publish sandboxes.
  cookie: { secure: true, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax", path: "/" },
}));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize the sql.js-backed database (loads data.db into memory) before
  // any request handler can touch storage.
  await initStorage();

  registerAuthRoutes(app);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
