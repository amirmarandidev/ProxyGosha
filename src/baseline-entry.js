// Rollback entry point for deployments that have already adopted Wrangler's
// declarative Durable Object exports lifecycle. Keep the original worker.js
// untouched while retaining the exported Durable Object class required by the
// production Wrangler configuration.
export { default } from "../worker.js";
export { ProxyGoshaControlPlane } from "./observability/control-plane.ts";
