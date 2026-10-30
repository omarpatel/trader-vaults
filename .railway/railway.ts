import { defineRailway, project, service, database } from "railway/iac";

export default defineRailway(() => {
  const postgres = database("postgres");

  const web = service("vault", {
    environment: "production",
    start: "node app.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 180,
    restartPolicy: "on_failure",
    env: [
      "DATABASE_URL",
      "PORT=8787",
      "NODE_ENV=production"
    ]
  });

  return project("trader-vaults", {
    resources: [web, postgres],
  });
});