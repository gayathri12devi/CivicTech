# CivicTech — Public Works Coordination & Accountability

A runnable full-stack MVP for coordinating public works and making project progress transparent.

## Included
- React + TypeScript + Vite resident and staff portal
- Express + TypeScript REST API
- PostgreSQL + PostGIS via Docker Compose
- Prisma data models
- Authentication and server-side permission checks
- Citizen, department officer, supervisor, and administrator roles
- Project proposals, approval, schedule updates, PostGIS-based spatial/time conflict detection
- Progress updates, complaints, restoration inspections, notifications, audit events
- Seeded demo accounts and sample projects

## Prerequisites
- Docker Desktop (recommended) OR Node.js 20+ and a PostgreSQL/PostGIS database
- npm

## Quick start
1. Copy `.env.example` to `.env`.
2. From the repository root run:
   ```bash
   docker compose up --build
   ```
3. Open http://localhost:5173

The API is available at http://localhost:4000/api/health.

### Demo accounts
All demo accounts use password `CivicTech123!`:
- Citizen: `citizen@civictech.local`
- Officer: `officer@civictech.local`
- Supervisor: `supervisor@civictech.local`
- Administrator: `admin@civictech.local`

These are local demo credentials only. Change all credentials and secrets before any public deployment.

## Local development without Docker
- Start a PostgreSQL database with PostGIS enabled.
- Set `DATABASE_URL` in `apps/api/.env`.
- `cd apps/api && npm install && npx prisma db push && npm run db:spatial && npm run seed && npm run dev`
- In another terminal: `cd apps/web && npm install && npm run dev`

## Architecture notes
- Prisma manages relational models; a small raw SQL layer uses PostGIS for geometry intersection and distance queries.
- Project work areas are stored as GeoJSON and indexed with a PostGIS expression index.
- A point location (latitude/longitude) is also stored for map display and proximity fallback.
- The API is intentionally a starter implementation. Before real deployment, add email verification, rate limiting, robust refresh/session handling, secure production secrets, backups, monitoring, formal officer verification, and a security review.
- Citizen reports are not official project changes. Only authorized staff can update official project status and evidence.
- Conflict detection produces review alerts; it does not automatically reject projects.

## Important limitation
The project uses sample data and demonstration identities. It does not connect to any municipal government system and does not prove that a real-world project or officer is genuine.
