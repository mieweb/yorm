/**
 * Dev server: the POC Hono app (REST + y-protocols WebSocket at `/yorm`)
 * with the contacts fixture pre-seeded. `PORT` defaults to 3000;
 * `YORM_SQLITE_FILE` switches from in-memory to a database file.
 */
import { serve } from "@hono/node-server";

import { createPocServer, loadContactsFixture, seedContacts } from "./setup.js";

const port = Number(process.env.PORT ?? 3000);
const file = process.env.YORM_SQLITE_FILE;
const poc = createPocServer(file !== undefined ? { file } : {});
await seedContacts(poc.yorm, loadContactsFixture());

const server = serve({ fetch: poc.app.fetch, port }, (info) => {
  console.log(`YORM contacts POC listening on http://localhost:${info.port}`);
  console.log(`  GET   http://localhost:${info.port}/yorm/docs/Patient/c-100`);
  console.log(`  GET   http://localhost:${info.port}/yorm/docs/Patient/c-100/projection-state`);
  console.log(`  WS    ws://localhost:${info.port}/yorm/ws/Patient/c-100`);
});
poc.injectWebSocket(server);
