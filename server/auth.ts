import type { Express } from "express";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { insertUserSchema } from "@shared/schema";
import { ADMIN_ONLY, LOGIN_MAX_FAILED, LOGIN_WINDOW_MS } from "./access";

// In-memory failed-login tracker (single server instance), keyed by email and by client address.
const failedLogins = new Map<string, number[]>();
function recentFailures(key: string): number {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const list = (failedLogins.get(key) || []).filter(t => t > cutoff);
  failedLogins.set(key, list);
  return list.length;
}
function recordFailure(...keys: string[]) {
  for (const k of keys) failedLogins.set(k, [...(failedLogins.get(k) || []), Date.now()]);
}

export function registerAuthRoutes(app: Express) {
  // POST /api/auth/register
  // Public self-service sign-up is disabled once the first (admin) account exists.
  // This keeps the app closed to the public: only the owner/admin account can log in
  // and use the platform, so visitors with the link can't create their own free accounts.
  // An already-authenticated admin can still create additional accounts (e.g. for farmers
  // they want to onboard) by calling this same endpoint while logged in.
  app.post("/api/auth/register", async (req, res) => {
    try {
      // Sign-up is never public. The administrator account is created at start-up (see storage.ts);
      // only a signed-in administrator can create further accounts.
      const isFirst = false;
      const requester = req.session?.userId ? storage.getUserById(req.session.userId) : undefined;
      if (!requester || requester.role !== "admin") {
        return res.status(403).json({ error: "Public registration is disabled. Contact the administrator for access." });
      }

      const { name, email, password, role } = insertUserSchema.parse(req.body);

      if (storage.getUserByEmail(email)) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = storage.createUser({
        name,
        email,
        passwordHash,
        role: isFirst ? "admin" : (role || "farmer"),
      });

      // Only auto-login the newly created account when it's the very first (admin) signup.
      // If an admin is creating another user's account, keep the admin's own session active.
      if (isFirst) {
        req.session.userId = user.id;
      }
      res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (e) {
      res.status(400).json({ error: "Invalid data", details: String(e) });
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });

      const emailKey = `email:${String(email).toLowerCase()}`;
      const ipKey = `ip:${req.ip}`;
      if (recentFailures(emailKey) >= LOGIN_MAX_FAILED || recentFailures(ipKey) >= LOGIN_MAX_FAILED * 4) {
        return res.status(429).json({ error: "Too many failed sign-in attempts. Please wait 15 minutes and try again." });
      }

      const user = storage.getUserByEmail(email);
      const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
      if (!user || !valid) {
        recordFailure(emailKey, ipKey);
        return res.status(401).json({ error: "Invalid email or password" });
      }
      if (ADMIN_ONLY && user.role !== "admin") {
        return res.status(403).json({ error: "Access is currently limited to the administrator." });
      }
      failedLogins.delete(emailKey);

      req.session.userId = user.id;
      res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (e) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("__Host-ntgs_session", { path: "/" });
      res.json({ ok: true });
    });
  });

  // GET /api/auth/me — check current session
  app.get("/api/auth/me", (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const user = storage.getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    if (ADMIN_ONLY && user.role !== "admin") return res.status(403).json({ error: "Access is currently limited to the administrator." });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });
}
