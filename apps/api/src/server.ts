import "dotenv/config";

import express from "express";

import cors from "cors";

import helmet from "helmet";

import bcrypt from "bcryptjs";

import jwt from "jsonwebtoken";

import { z } from "zod";

import { prisma } from "./db/client";

import { authenticate, allowRoles, AuthedRequest, canManageProject } from "./middleware/auth";

import { Prisma, ProjectStatus } from "@prisma/client";

const app = express();

app.use(helmet());

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));

app.use(express.json({ limit: "2mb" }));

type AsyncHandler = (

  req: express.Request,

  res: express.Response,

  next: express.NextFunction

) => Promise<unknown> | unknown;

const asyncRoute = (fn: AsyncHandler) =>

  (req: express.Request, res: express.Response, next: express.NextFunction) =>

    Promise.resolve(fn(req, res, next)).catch(next);

const userOf = (req: express.Request) => (req as AuthedRequest).user!;

// Express parameter types may be string | string[] depending on the installed
// Express type definitions. Validate that route IDs are a single string.
const paramId = (req: express.Request): string => {
  const id = req.params.id;
  if (typeof id !== "string") {
    throw new Error("Invalid route parameter: id");
  }
  return id;
};

async function audit(actorId: string, entityType: string, entityId: string, action: string, details?: unknown) {

  await prisma.auditEvent.create({

    data: { actorId, entityType, entityId, action, details: details as Prisma.InputJsonValue | undefined }

  });

}

async function notifyDepartment(departmentId: string, title: string, message: string) {

  const users = await prisma.user.findMany({ where: { departmentId, role: { in: ["DEPARTMENT_OFFICER", "SUPERVISOR"] }, accountStatus: "ACTIVE" } });

  if (users.length) await prisma.notification.createMany({ data: users.map(u => ({ userId: u.id, title, message })) });

}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "civictech-api" }));

app.post("/api/auth/register", asyncRoute(async (req, res) => {

  const schema = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(10) });

  const input = schema.parse(req.body);

  const email = input.email.toLowerCase();

  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ message: "An account with this email already exists." });

  const user = await prisma.user.create({ data: { name: input.name, email, passwordHash: await bcrypt.hash(input.password, 12), role: "CITIZEN", accountStatus: "ACTIVE" } });

  return res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });

}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {

  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

  const input = schema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });

  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ message: "Invalid email or password." });

  if (user.accountStatus !== "ACTIVE") return res.status(403).json({ message: "Your account is not active. Contact the administrator." });

  const secret = process.env.JWT_SECRET || "";

  if (secret.length < 32) return res.status(500).json({ message: "Configure a JWT_SECRET of at least 32 characters." });

  const token = jwt.sign({ sub: user.id }, secret, { expiresIn: "8h" });

  return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId } });

}));

app.get("/api/auth/me", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req);

  const user = await prisma.user.findUnique({ where: { id: u.id }, include: { department: true } });

  return res.json({ id: user!.id, name: user!.name, email: user!.email, role: user!.role, accountStatus: user!.accountStatus, department: user!.department });

}));

app.get("/api/departments", asyncRoute(async (_req, res) => res.json(await prisma.department.findMany({ orderBy: { name: "asc" } }))));

app.get("/api/public/projects", asyncRoute(async (req, res) => {

  const { search, status, locality } = req.query;

  const where: Prisma.ProjectWhereInput = { publicVisibility: true, status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] } };

  if (typeof status === "string" && status) where.status = status as ProjectStatus;

  if (typeof locality === "string" && locality) where.locality = { contains: locality, mode: "insensitive" };

  if (typeof search === "string" && search) where.OR = [{ title: { contains: search, mode: "insensitive" } }, { address: { contains: search, mode: "insensitive" } }, { purpose: { contains: search, mode: "insensitive" } }];

  const projects = await prisma.project.findMany({ where, include: { department: true, progressUpdates: { orderBy: { createdAt: "desc" }, take: 3 } }, orderBy: { plannedStart: "asc" } });

  return res.json(projects);

}));

app.get("/api/projects", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req);

  const where: Prisma.ProjectWhereInput = u.role === "ADMINISTRATOR" ? {} : u.role === "CITIZEN" ? { publicVisibility: true, status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] } } : { departmentId: u.departmentId || "__none__" };

  return res.json(await prisma.project.findMany({ where, include: { department: true, conflictsAsA: true, conflictsAsB: true }, orderBy: { updatedAt: "desc" } }));

}));

app.get("/api/projects/:id", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req);

  const p = await prisma.project.findUnique({

    where: { id: paramId(req) },

    include: {

      department: true,

      progressUpdates: {

        include: {

          author: {

            select: { id: true, name: true, role: true }

          }

        },

        orderBy: { createdAt: "desc" }

      },

      complaints: {

        where: u.role === "CITIZEN" ? { citizenId: u.id } : {},

        orderBy: { createdAt: "desc" }

      },

      inspections: { orderBy: { createdAt: "desc" } },

      conflictsAsA: true,

      conflictsAsB: true,

      schedules: { orderBy: { createdAt: "desc" } }

    }

  });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (!p.publicVisibility && u.role === "CITIZEN") {

    return res.status(403).json({ message: "This project is not public." });

  }

  if (["DEPARTMENT_OFFICER", "SUPERVISOR"].includes(u.role) && p.departmentId !== u.departmentId) {

    return res.status(403).json({ message: "This project belongs to another department." });

  }

  return res.json(p);

}));

const projectSchema = z.object({

  title: z.string().min(4), description: z.string().min(10), purpose: z.string().min(5), workType: z.string().min(2),

  departmentId: z.string(), contractorName: z.string().optional(), address: z.string().min(3), locality: z.string().min(2),

  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),

  workAreaGeoJson: z.any().optional(), plannedStart: z.string().datetime(), plannedEnd: z.string().datetime(),

  budget: z.number().nonnegative().optional()

});

app.post("/api/projects", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req);

  const input = projectSchema.parse(req.body);

  if (new Date(input.plannedEnd) <= new Date(input.plannedStart)) return res.status(400).json({ message: "Planned end must be after planned start." });

  if (u.role !== "ADMINISTRATOR" && u.departmentId !== input.departmentId) return res.status(403).json({ message: "You can only create projects for your assigned department." });

  const dept = await prisma.department.findUnique({ where: { id: input.departmentId } });

  if (!dept) return res.status(400).json({ message: "Department not found." });

  const project = await prisma.project.create({

    data: {

      ...input, plannedStart: new Date(input.plannedStart), plannedEnd: new Date(input.plannedEnd),

      originalPlannedEnd: new Date(input.plannedEnd), createdById: u.id,

      workAreaGeoJson: input.workAreaGeoJson ?? Prisma.JsonNull, status: "SUBMITTED", publicVisibility: false

    }

  });

  await audit(u.id, "Project", project.id, "PROJECT_SUBMITTED", { title: project.title });

  const conflicts = await detectAndStoreConflicts(project.id);

  return res.status(201).json({ project, conflicts });

}));

async function detectAndStoreConflicts(projectId: string) {

  const current = await prisma.project.findUnique({ where: { id: projectId } });

  if (!current) return [];

  const candidates = await prisma.project.findMany({

    where: {

      id: { not: current.id }, status: { notIn: ["REJECTED", "CANCELLED", "DRAFT"] },

      plannedStart: { lte: current.plannedEnd }, plannedEnd: { gte: current.plannedStart }

    }

  });

  const found: any[] = [];

  for (const candidate of candidates) {

    let spatialMatch = false;

    if (current.workAreaGeoJson && candidate.workAreaGeoJson) {

      try {

        const rows = await prisma.$queryRaw<Array<{ intersects: boolean }>>`

          SELECT ST_Intersects(

            ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(current.workAreaGeoJson)}), 4326),

            ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(candidate.workAreaGeoJson)}), 4326)

          ) AS intersects

        `;

        spatialMatch = Boolean(rows[0]?.intersects);

      } catch { spatialMatch = false; }

    } else {

      const rows = await prisma.$queryRaw<Array<{ meters: number }>>`

        SELECT ST_Distance(

          ST_SetSRID(ST_MakePoint(${current.longitude}, ${current.latitude}), 4326)::geography,

          ST_SetSRID(ST_MakePoint(${candidate.longitude}, ${candidate.latitude}), 4326)::geography

        ) AS meters

      `;

      spatialMatch = Number(rows[0]?.meters ?? 999999) <= 100;

    }

    if (!spatialMatch) continue;

    const exists = await prisma.conflict.findFirst({

      where: {

        OR: [

          { projectAId: current.id, projectBId: candidate.id },

          { projectAId: candidate.id, projectBId: current.id }

        ]

      }

    });

    if (!exists) {

      const conflict = await prisma.conflict.create({

        data: {

          projectAId: current.id, projectBId: candidate.id,

          reason: current.workAreaGeoJson && candidate.workAreaGeoJson ? "Work areas intersect and scheduled dates overlap." : "Projects are within 100 metres and scheduled dates overlap.",

          severity: "HIGH"

        }

      });

      found.push(conflict);

      await notifyDepartment(candidate.departmentId, "Potential works conflict", `A new proposal may overlap with project "${candidate.title}". Please review coordination.`);

      await notifyDepartment(current.departmentId, "Potential works conflict", `Project "${candidate.title}" may overlap with another scheduled project. Please review coordination.`);

    }

  }

  return found;

}

app.post("/api/projects/:id/submit", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (!canManageProject(u, p)) return res.status(403).json({ message: "Not authorized for this department." });

  const updated = await prisma.project.update({ where: { id: p.id }, data: { status: "SUBMITTED" } });

  const conflicts = await detectAndStoreConflicts(p.id);

  await audit(u.id, "Project", p.id, "PROJECT_RESUBMITTED");

  return res.json({ project: updated, conflicts });

}));

app.post("/api/projects/:id/approve", authenticate, allowRoles("SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (u.role !== "ADMINISTRATOR" && p.departmentId !== u.departmentId) return res.status(403).json({ message: "Not authorized for this department." });

  if (!["SUBMITTED", "UNDER_REVIEW"].includes(p.status)) return res.status(409).json({ message: "Only submitted or under-review projects can be approved." });

  const updated = await prisma.project.update({ where: { id: p.id }, data: { status: "APPROVED", publicVisibility: true } });

  await audit(u.id, "Project", p.id, "PROJECT_APPROVED");

  return res.json(updated);

}));

app.patch("/api/projects/:id/status", authenticate, allowRoles("SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const schema = z.object({ status: z.enum(["SCHEDULED", "IN_PROGRESS", "ON_HOLD", "RESTORATION_PENDING", "COMPLETED", "CANCELLED"]), reason: z.string().optional() });

  const input = schema.parse(req.body); const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (u.role !== "ADMINISTRATOR" && p.departmentId !== u.departmentId) return res.status(403).json({ message: "Not authorized for this department." });

  if (input.status === "COMPLETED") {

    const inspection = await prisma.inspection.findFirst({ where: { projectId: p.id, outcome: "PASSED" } });

    if (!inspection) return res.status(409).json({ message: "A passed restoration inspection is required before completion." });

  }

  const updated = await prisma.project.update({

    where: { id: p.id }, data: {

      status: input.status as ProjectStatus,

      ...(input.status === "IN_PROGRESS" && !p.actualStart ? { actualStart: new Date() } : {}),

      ...(input.status === "COMPLETED" ? { actualEnd: new Date() } : {}),

      ...(input.reason ? { delayReason: input.reason } : {})

    }

  });

  await audit(u.id, "Project", p.id, "STATUS_CHANGED", { from: p.status, to: input.status, reason: input.reason });

  if (p.publicVisibility) {

    const citizens = await prisma.user.findMany({ where: { role: "CITIZEN" } });

    if (citizens.length) await prisma.notification.createMany({ data: citizens.map(c => ({ userId: c.id, title: "Public works update", message: `${p.title}: status changed to ${input.status}${input.reason ? `. Reason: ${input.reason}` : ""}.` })) });

  }

  return res.json(updated);

}));

app.patch("/api/projects/:id/schedule", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const input = z.object({ plannedStart: z.string().datetime(), plannedEnd: z.string().datetime(), reason: z.string().min(5) }).parse(req.body);

  const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (!canManageProject(u, p)) return res.status(403).json({ message: "Not authorized for this department." });

  const start = new Date(input.plannedStart), end = new Date(input.plannedEnd);

  if (end <= start) return res.status(400).json({ message: "End must be after start." });

  await prisma.$transaction(async tx => {

    await tx.scheduleRevision.create({ data: { projectId: p.id, oldStart: p.plannedStart, oldEnd: p.plannedEnd, newStart: start, newEnd: end, reason: input.reason, changedById: u.id } });

    await tx.project.update({ where: { id: p.id }, data: { plannedStart: start, plannedEnd: end, delayReason: input.reason } });

    await tx.auditEvent.create({ data: { actorId: u.id, entityType: "Project", entityId: p.id, action: "SCHEDULE_REVISED", details: { reason: input.reason, oldEnd: p.plannedEnd.toISOString(), newEnd: end.toISOString() } } });

  });

  const conflicts = await detectAndStoreConflicts(p.id);

  await notifyDepartment(p.departmentId, "Project schedule changed", `${p.title} schedule changed. Reason: ${input.reason}`);

  return res.json({ ok: true, conflicts });

}));

app.get("/api/conflicts", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {
  const u = userOf(req);
  const allConflicts = await prisma.conflict.findMany({
    orderBy: { createdAt: "desc" }
  });

  // Load the related projects by their scalar foreign keys. This avoids relying
  // on relation names that are not present in the generated Conflict type.
  const conflictsWithProjects = await Promise.all(allConflicts.map(async (conflict) => {
    const [projectA, projectB] = await Promise.all([
      prisma.project.findUnique({ where: { id: conflict.projectAId }, include: { department: true } }),
      prisma.project.findUnique({ where: { id: conflict.projectBId }, include: { department: true } })
    ]);

    return { ...conflict, projectA, projectB };
  }));

  const visibleConflicts = u.role === "ADMINISTRATOR"
    ? conflictsWithProjects
    : conflictsWithProjects.filter(({ projectA, projectB }) =>
        projectA?.departmentId === u.departmentId ||
        projectB?.departmentId === u.departmentId
      );

  return res.json(visibleConflicts);
}));

app.post("/api/conflicts/:id/resolve", authenticate, allowRoles("SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {
  const u = userOf(req);
  const input = z.object({
    status: z.enum(["RESOLVED", "ACCEPTED_EXCEPTION", "DISMISSED"]),
    resolution: z.string().min(5)
  }).parse(req.body);

  const conflict = await prisma.conflict.findUnique({
    where: { id: paramId(req) }
  });

  if (!conflict) {
    return res.status(404).json({ message: "Conflict not found." });
  }

  const [projectA, projectB] = await Promise.all([
    prisma.project.findUnique({ where: { id: conflict.projectAId } }),
    prisma.project.findUnique({ where: { id: conflict.projectBId } })
  ]);

  if (!projectA || !projectB) {
    return res.status(409).json({ message: "One or both projects for this conflict no longer exist." });
  }

  if (
    u.role !== "ADMINISTRATOR" &&
    projectA.departmentId !== u.departmentId &&
    projectB.departmentId !== u.departmentId
  ) {
    return res.status(403).json({ message: "Not authorized for this conflict." });
  }

  const updated = await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: input.status, resolution: input.resolution, resolvedById: u.id }
  });

  await audit(u.id, "Conflict", conflict.id, "CONFLICT_RESOLVED", input);
  return res.json(updated);
}));

app.post("/api/projects/:id/progress", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const input = z.object({ milestone: z.string().min(2), notes: z.string().min(3), evidenceUrl: z.string().url().optional(), percent: z.number().int().min(0).max(100).optional() }).parse(req.body);

  const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (!canManageProject(u, p)) return res.status(403).json({ message: "Not authorized for this department." });

  const update = await prisma.progressUpdate.create({ data: { ...input, projectId: p.id, authorId: u.id } });

  await audit(u.id, "Project", p.id, "PROGRESS_UPDATED", { milestone: input.milestone, percent: input.percent });

  return res.status(201).json(update);

}));

app.post("/api/projects/:id/complaints", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req); const input = z.object({ category: z.enum(["DELAY", "SAFETY", "POOR_RESTORATION", "INACCURATE_INFO", "OTHER"]), description: z.string().min(10), evidenceUrl: z.string().url().optional() }).parse(req.body);

  const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p || (!p.publicVisibility && u.role === "CITIZEN")) return res.status(404).json({ message: "Public project not found." });

  const complaint = await prisma.complaint.create({ data: { ...input, projectId: p.id, citizenId: u.id } });

  await notifyDepartment(p.departmentId, "New citizen report", `A report was submitted for ${p.title}.`);

  await audit(u.id, "Project", p.id, "COMPLAINT_SUBMITTED", { complaintId: complaint.id, category: input.category });

  return res.status(201).json(complaint);

}));

app.get("/api/complaints", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req);

  const where: Prisma.ComplaintWhereInput = u.role === "ADMINISTRATOR" ? {} : u.role === "CITIZEN" ? { citizenId: u.id } : { project: { departmentId: u.departmentId || "__none__" } };

  return res.json(await prisma.complaint.findMany({ where, include: { project: true, citizen: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } }));

}));

app.patch("/api/complaints/:id", authenticate, allowRoles("DEPARTMENT_OFFICER", "SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const input = z.object({ status: z.enum(["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "CLOSED", "REJECTED"]), response: z.string().min(3) }).parse(req.body);

  const c = await prisma.complaint.findUnique({ where: { id: paramId(req) }, include: { project: true } });

  if (!c) return res.status(404).json({ message: "Complaint not found." });

  if (u.role !== "ADMINISTRATOR" && c.project.departmentId !== u.departmentId) return res.status(403).json({ message: "Not authorized for this complaint." });

  const updated = await prisma.complaint.update({ where: { id: c.id }, data: input });

  await prisma.notification.create({ data: { userId: c.citizenId, title: "Your report was updated", message: `${c.project.title}: ${input.status}. ${input.response}` } });

  return res.json(updated);

}));

app.post("/api/projects/:id/inspections", authenticate, allowRoles("SUPERVISOR", "ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const u = userOf(req); const input = z.object({ outcome: z.enum(["PASSED", "FAILED", "NEEDS_REWORK"]), notes: z.string().min(5), evidenceUrl: z.string().url().optional() }).parse(req.body);

  const p = await prisma.project.findUnique({ where: { id: paramId(req) } });

  if (!p) return res.status(404).json({ message: "Project not found." });

  if (u.role !== "ADMINISTRATOR" && p.departmentId !== u.departmentId) return res.status(403).json({ message: "Not authorized for this department." });

  const inspection = await prisma.inspection.create({ data: { projectId: p.id, inspectorId: u.id, ...input } });

  await audit(u.id, "Project", p.id, "RESTORATION_INSPECTED", { outcome: input.outcome });

  return res.status(201).json(inspection);

}));

app.get("/api/notifications", authenticate, asyncRoute(async (req, res) => {

  return res.json(await prisma.notification.findMany({ where: { userId: userOf(req).id }, orderBy: { createdAt: "desc" }, take: 100 }));

}));

app.patch("/api/notifications/:id/read", authenticate, asyncRoute(async (req, res) => {

  const u = userOf(req); const n = await prisma.notification.findUnique({ where: { id: paramId(req) } });

  if (!n || n.userId !== u.id) return res.status(404).json({ message: "Notification not found." });

  return res.json(await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } }));

}));

app.get("/api/admin/audit", authenticate, allowRoles("ADMINISTRATOR"), asyncRoute(async (_req, res) => {

  return res.json(await prisma.auditEvent.findMany({ include: { actor: { select: { name: true, email: true, role: true } } }, orderBy: { createdAt: "desc" }, take: 250 }));

}));

app.post("/api/admin/officers/:id/activate", authenticate, allowRoles("ADMINISTRATOR"), asyncRoute(async (req, res) => {

  const input = z.object({ departmentId: z.string(), role: z.enum(["DEPARTMENT_OFFICER", "SUPERVISOR"]) }).parse(req.body);

  const target = await prisma.user.findUnique({ where: { id: paramId(req) } });

  if (!target) return res.status(404).json({ message: "User not found." });

  const dept = await prisma.department.findUnique({ where: { id: input.departmentId } });

  if (!dept) return res.status(400).json({ message: "Department not found." });

  const updated = await prisma.user.update({ where: { id: target.id }, data: { departmentId: dept.id, role: input.role, accountStatus: "ACTIVE" } });

  await audit(userOf(req).id, "User", updated.id, "OFFICER_ACTIVATED", { departmentId: dept.id, role: input.role });

  return res.json({ id: updated.id, email: updated.email, role: updated.role, departmentId: updated.departmentId });

}));

app.get("/api/admin/users/pending", authenticate, allowRoles("ADMINISTRATOR"), asyncRoute(async (_req, res) => {

  return res.json(await prisma.user.findMany({ where: { accountStatus: "PENDING_VERIFICATION" }, select: { id: true, name: true, email: true, role: true, accountStatus: true } }));

}));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {

  if (err instanceof z.ZodError) return res.status(400).json({ message: "Validation failed.", errors: err.flatten() });

  console.error(err);

  return res.status(500).json({ message: "Unexpected server error." });

});

const port = Number(process.env.PORT || 4000);

app.listen(port, () => console.log(`CivicTech API listening on ${port}`));
