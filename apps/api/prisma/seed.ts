import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db/client";

async function main() {
  const departments = [
    { name: "Roads & Highways", type: "ROADS", jurisdiction: "Demo locality" },
    { name: "Water Supply", type: "WATER", jurisdiction: "Demo locality" },
    { name: "Drainage & Sewerage", type: "DRAINAGE", jurisdiction: "Demo locality" },
    { name: "Telecommunications", type: "TELECOM", jurisdiction: "Demo locality" }
  ];
  const depts = [];
  for (const d of departments) {
    depts.push(await prisma.department.upsert({ where: { id: d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") }, update: {}, create: { id: d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), ...d } }).catch(async () => {
      const existing = await prisma.department.findFirst({ where: { name: d.name } });
      return existing || prisma.department.create({ data: d });
    }));
  }
  const pass = await bcrypt.hash("CivicTech123!", 10);
  const users = [
    { name: "Demo Citizen", email: "citizen@civictech.local", role: "CITIZEN" as const, departmentId: null },
    { name: "Demo Officer", email: "officer@civictech.local", role: "DEPARTMENT_OFFICER" as const, departmentId: depts[1].id },
    { name: "Demo Supervisor", email: "supervisor@civictech.local", role: "SUPERVISOR" as const, departmentId: depts[1].id },
    { name: "Demo Administrator", email: "admin@civictech.local", role: "ADMINISTRATOR" as const, departmentId: null }
  ];
  const saved: any = {};
  for (const u of users) {
    saved[u.role] = await prisma.user.upsert({
      where: { email: u.email }, update: { name: u.name, role: u.role, departmentId: u.departmentId, accountStatus: "ACTIVE" },
      create: { ...u, passwordHash: pass, accountStatus: "ACTIVE" }
    });
  }
  const count = await prisma.project.count();
  if (!count) {
    const start = new Date(); start.setDate(start.getDate() + 3);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const areaA = { type: "LineString", coordinates: [[80.23, 13.08], [80.231, 13.081], [80.232, 13.082]] };
    const areaB = { type: "LineString", coordinates: [[80.231, 13.081], [80.232, 13.082], [80.233, 13.083]] };
    const p1 = await prisma.project.create({ data: {
      title: "Water pipeline replacement", description: "Replace an aging water pipeline and repair the road surface after installation.",
      purpose: "Improve water supply reliability", workType: "WATER_PIPELINE", departmentId: depts[1].id, createdById: saved.DEPARTMENT_OFFICER.id,
      contractorName: "Demo Infrastructure Contractor", address: "Main Street", locality: "Demo Nagar", latitude: 13.081, longitude: 80.231,
      workAreaGeoJson: areaA, plannedStart: start, plannedEnd: end, originalPlannedEnd: end, status: "APPROVED", publicVisibility: true
    }});
    const s2 = new Date(start); s2.setDate(s2.getDate() + 2);
    const e2 = new Date(end); e2.setDate(e2.getDate() + 2);
    await prisma.project.create({ data: {
      title: "Drainage maintenance", description: "Inspect and repair the roadside drainage channel.",
      purpose: "Reduce local flooding risk", workType: "DRAINAGE", departmentId: depts[2].id, createdById: saved.DEPARTMENT_OFFICER.id,
      contractorName: "Demo Civil Works", address: "Main Street junction", locality: "Demo Nagar", latitude: 13.082, longitude: 80.232,
      workAreaGeoJson: areaB, plannedStart: s2, plannedEnd: e2, originalPlannedEnd: e2, status: "SUBMITTED", publicVisibility: false
    }});
    await prisma.progressUpdate.create({ data: { projectId: p1.id, authorId: saved.DEPARTMENT_OFFICER.id, milestone: "Site preparation", notes: "Demo update for the seeded project.", percent: 10 } });
  }
  console.log("Seed complete. Demo password: CivicTech123!");
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
