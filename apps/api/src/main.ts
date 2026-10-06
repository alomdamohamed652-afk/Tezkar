import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  credentials: true
});
await app.register(cookie);

app.get("/health", async () => ({
  status: "ok",
  service: "tezkar-api"
}));

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ host: "0.0.0.0", port });
