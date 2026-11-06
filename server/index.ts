import { createApp } from "./app";
const { app, db } = createApp();
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(
    `Злой инвестор: http://localhost:${port} (${process.env.AGENT_API_URL ? "live" : "stub"})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
