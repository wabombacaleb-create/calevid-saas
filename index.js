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

/* ======================
   ENV VALIDATION
====================== */
if (!process.env.WP_SITE_URL) {
  throw new Error("WP_SITE_URL is not set");
}
if (!process.env.CALEVID_WEBHOOK_SECRET) {
  throw new Error("CALEVID_WEBHOOK_SECRET is not set");
}
if (!process.env.PAYSTACK_SECRET_KEY) {
  throw new Error("PAYSTACK_SECRET_KEY is not set");
}
if (!process.env.FAL_KEY) {
  throw new Error("FAL_KEY is not set");
}

const WP_SITE_URL = process.env.WP_SITE_URL.trim().replace(/\/+$/, "");

/* ======================
   HTTPS AGENT
====================== */
const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: true,
  family: 4,
});

/* ======================
   MIDDLEWARE
====================== */
app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* ======================
   FAL CONFIG
====================== */
fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "calevid-backend" });
});

/* ======================
   PAYSTACK WEBHOOK
====================== */
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const rawBody = req.body;
  const signature = req.headers["x-paystack-signature"];

  const computedHash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  if (computedHash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.sendStatus(400);
  }

  // Respond immediately (Paystack requirement)
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  setImmediate(async () => {
    const wpUrl = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    log("Calling WordPress:", wpUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(wpUrl, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Calevid-Webhook/1.0",
        },
        body: JSON.stringify({
          secret: process.env.CALEVID_WEBHOOK_SECRET,
          email,
          credits,
          reference,
        }),
      });

      const text = await response.text();
      log("✅ WordPress responded", response.status, text);
    } catch (err) {
      log("❌ WordPress request failed", err.name, err.message);
    } finally {
      clearTimeout(timeout);
    }
  });
});

/* ======================
   VIDEO GENERATION
====================== */
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

/* ======================
   START SERVER
====================== */
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});
