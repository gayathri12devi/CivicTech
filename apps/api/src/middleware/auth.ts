import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db/client";

export type Role = "CITIZEN" | "DEPARTMENT_OFFICER" | "SUPERVISOR" | "ADMINISTRATOR";
export interface AuthedRequest extends Request {
  user?: { id: string; role: Role; departmentId: string | null; accountStatus: string; email: string };
}

export async function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Sign in required." });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ message: "JWT_SECRET must be at least 32 characters." });
    const decoded = jwt.verify(header.slice(7), secret) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.accountStatus !== "ACTIVE") return res.status(401).json({ message: "Account is unavailable." });
    req.user = { id: user.id, role: user.role, departmentId: user.departmentId, accountStatus: user.accountStatus, email: user.email };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

export function allowRoles(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ message: "You do not have permission for this action." });
    next();
  };
}

export function canManageProject(user: NonNullable<AuthedRequest["user"]>, project: { departmentId: string; createdById?: string }) {
  if (user.role === "ADMINISTRATOR") return true;
  if (user.role === "SUPERVISOR") return user.departmentId === project.departmentId;
  return user.role === "DEPARTMENT_OFFICER" && user.departmentId === project.departmentId;
}
