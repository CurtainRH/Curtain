/**
 * Process entry point: run migrations, then serve. Deployed via backend/Dockerfile.
 */
import { bunSqlDb, migrate } from "@curtain/db";
import { createApp } from "./app";

const db = await bunSqlDb();
const ran = await migrate(db);
if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);

const server = Bun.serve({ port: Number(process.env["API_PORT"] ?? process.env["PORT"] ?? 3000), fetch: createApp(db) });
console.log(`@curtain/api listening on :${server.port}`);
