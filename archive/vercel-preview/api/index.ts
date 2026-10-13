// Vercel serverless entrypoint. NOT the production deployment target — see
// README.md "Deploying to a VPS with Docker" for the real one. This exists
// only to make a Vercel preview URL possible; the app's SQLite storage does
// not durably persist between serverless invocations (see report). Every
// module here is the same createApp() used by src/index.ts, unmodified.
import { getDb } from '../src/memory/db';
import { createApp } from '../src/app';

getDb();

export default createApp();
