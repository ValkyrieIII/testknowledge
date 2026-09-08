import { createApp } from "./app.js";

const port = Number(process.env.TESTKNOWLEDGE_PORT ?? 4173);
const app = createApp();
await app.listen({ host: "127.0.0.1", port });
