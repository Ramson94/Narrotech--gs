import type { Request, Response, NextFunction } from "express";

// Augment session type — must be here so it's loaded before auth.ts
declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: "Unauthorized" });
}

import { storage } from "./storage";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const user = storage.getUserById(req.session.userId);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
