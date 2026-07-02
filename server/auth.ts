import type { Express } from "express";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { insertUserSchema } from "@shared/schema";

export function registerAuthRoutes(app: Express) {
  // POST /api/auth/register
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { name, email, password, role } = insertUserSchema.parse(req.body);

      if (storage.getUserByEmail(email)) {
        return res.status(409).json({ error: "Email already registered" });
      }

      // First user ever becomes admin automatically
      const isFirst = storage.countUsers() === 0;
      const passwordHash = await bcrypt.hash(password, 10);
      const user = storage.createUser({
        name,
        email,
        passwordHash,
        role: isFirst ? "admin" : (role || "farmer"),
      });

      req.session.userId = user.id;
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

      const user = storage.getUserByEmail(email);
      if (!user) return res.status(401).json({ error: "Invalid email or password" });

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: "Invalid email or password" });

      req.session.userId = user.id;
      res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (e) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("__Host-ntgs");
      res.json({ ok: true });
    });
  });

  // GET /api/auth/me — check current session
  app.get("/api/auth/me", (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
    const user = storage.getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });
}
