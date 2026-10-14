import { prisma } from "./client";

async function main() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Project_workArea_spatial_idx"
    ON "Project"
    USING GIST (
      ST_SetSRID(ST_GeomFromGeoJSON("workAreaGeoJson"::text), 4326)
    )
    WHERE "workAreaGeoJson" IS NOT NULL
  `);
  console.log("PostGIS spatial expression index ready.");
}

main().catch((error) => {
  console.error("Could not create spatial index. Is PostGIS enabled?", error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
