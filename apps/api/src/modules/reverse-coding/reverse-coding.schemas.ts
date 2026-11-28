import { z } from "zod";

export const reverseScanRequestSchema=z.object({
  values:z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  sessionId:z.string().uuid()
});
