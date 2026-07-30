import { config } from "dotenv";
config();
// Point every prisma client in the test process at the test database.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
