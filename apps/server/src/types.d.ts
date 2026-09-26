import type { AccessClaims } from "./auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    requestContext?: AccessClaims;
  }
}
