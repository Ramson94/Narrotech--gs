import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");

  // IMPORTANT: In the pplx.app publish sandbox, static files (HTML/CSS/JS) are
  // uploaded to S3 and served directly by the platform — this backend process
  // only ever receives /api/* requests. The local dist/public folder may not
  // exist (or may differ) inside that sandbox's filesystem layout.
  // Previously this threw synchronously when dist/public was missing, which
  // rejected the async IIFE in index.ts (uncaught, no try/catch around it) and
  // prevented httpServer.listen() from ever running — causing the platform to
  // report "No service is running on port 5000" for EVERY route, including
  // /api/auth/login, /api/fields/*/report, and /api/fields/*/notify-whatsapp.
  // Make this non-fatal: log a warning and skip local static serving instead
  // of crashing the whole process. API routes registered earlier still work.
  if (!fs.existsSync(distPath)) {
    console.warn(
      `WARNING: build directory not found at ${distPath} — skipping local static file serving ` +
      `(this is expected when static assets are served separately, e.g. via S3 on pplx.app). ` +
      `API routes will continue to function normally.`,
    );
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
