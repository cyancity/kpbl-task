import type { AccessClaims } from "./auth/session.js";
import type { AppContext } from "./context.js";

declare module "fastify" {
  interface FastifyRequest {
    requestContext?: AccessClaims;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}
