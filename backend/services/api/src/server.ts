/**
 * Process entry point: run migrations, then serve. Deployed via backend/Dockerfile.
 */
import { handle } from "./app";
import { createDb } from "./db";
import { migrate } from "./migrate";

const ran = await migrate(createDb());
if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);

const server = Bun.serve({ port: Number(process.env.API_PORT ?? process.env.PORT ?? 3000), fetch: handle });
console.log(`@curtain/api listening on :${server.port}`);
