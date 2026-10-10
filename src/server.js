import { createApp } from './app.js';
const app = createApp();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`練習室：http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { app.locals.db.close(); process.exit(0); }));
