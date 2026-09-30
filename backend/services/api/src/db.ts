import { SQL } from "bun";

export function createDb(url = process.env.DATABASE_URL): SQL {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new SQL(url);
}
