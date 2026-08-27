import { Router, type IRouter } from "express";
import { getGeminiHealth } from "../lib/gemini.js";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const gemini = await getGeminiHealth();
  res.json({ status: "ok", gemini });
});

export default router;
