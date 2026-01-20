import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import https from "https";
import dns from "dns";
import { fal } from "@fal-ai/client";

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   CONFIG
========================= */
const WP_SITE_URL = (process.env.WP_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.CALEVID_WEBHOOK_SECRET;

fal.config({
  credentials: process.env.FAL_KEY,
});

/* =========================
   GLOBAL MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json()); // SAFE for all routes except webhook

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: true,
  family: 4,
});

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* =========================
   PAYSTACK WEBHOOK (RAW BODY)
========================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    log("🔥 PAYSTACK WEBHOOK HIT");

    const signature = req.headers["x-paystack-signature"];

    if (!signature || !PAYSTACK_SECRET) {
      log("❌ Missing Paystack signature or secret");
      return res.sendStatus(401);
    }

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(req.body) // RAW BUFFER (CRITICAL)
      .digest("hex");

    if (hash !== signature) {
      log("❌ Invalid Paystack signature");
      return res.sendStatus(401);
    }

    log("✅ Paystack signature verified");

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.sendStatus(400);
    }

    // Respond immediately to Paystack
    res.sendStatus(200);

    if (event.event !== "charge.success") return;

    const { reference, customer, amount } = event.data;

    const email = (customer?.email || "").trim();
    const credits = Math.floor(amount / 100 / 150);

    if (!email || credits <= 0) {
      log("❌ Invalid credit payload");
      return;
    }

    log("💳 Applying credits", { email, credits, reference });

    setImmediate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const wpRes = await fetch(
          `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`,
          {
            method: "POST",
            agent: httpsAgent,
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "User-Agent": "Calevid-Webhook/1.0",
            },
            body: JSON.stringify({
              secret: WEBHOOK_SECRET,
              email,
              credits,
              reference,
            }),
          }
        );

        const text = await wpRes.text();
        log("✅ WordPress response", wpRes.status, text);
      } catch (err) {
        log("❌ WordPress request failed", err.name, err.message);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
);

/* =========================
   VIDEO GENERATION (fal.ai)
========================= */
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    res.json({
      status: "success",
      videoUrl: result?.data?.video?.url || null,
    });
  } catch (err) {
    log("❌ Video generation failed", err.message);
    res.status(500).json({ error: "Generation failed" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});
