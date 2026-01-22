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
   PAYSTACK WEBHOOK
========================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    log("🔥 PAYSTACK WEBHOOK HIT");

    const body = req.body;
    const signature = req.headers["x-paystack-signature"];
    const secretKey = PAYSTACK_SECRET || "";

    if (!signature || !secretKey) {
      log("❌ Missing Paystack signature or secret");
      return res.sendStatus(401);
    }

    const hash = crypto
      .createHmac("sha512", secretKey)
      .update(body)
      .digest("hex");

    if (hash !== signature) {
      log("❌ Invalid Paystack signature");
      return res.sendStatus(401);
    }

    let event;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch (e) {
      log("❌ Failed to parse webhook body", e.message);
      return res.sendStatus(400);
    }

    log("🔔 Paystack event:", event?.event, event?.data?.status);

    res.sendStatus(200); // acknowledge Paystack immediately

    if (event.event !== "charge.success" || event.data?.status !== "success") {
      return;
    }

    const { reference, customer, amount } = event.data || {};
    const email = (customer?.email || "").trim();
    const credits = Math.floor((amount || 0) / 100 / 150);

    if (!email || !reference || credits <= 0) {
      log("⚠️ Invalid data", { email, reference, credits });
      return;
    }

    if (!WP_SITE_URL || !WEBHOOK_SECRET) {
      log("❌ Missing WP_SITE_URL or CALEVID_WEBHOOK_SECRET");
      return;
    }

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    log("➡️ Calling WordPress:", url);

    const agent = new https.Agent({ keepAlive: true });

    setImmediate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const wpRes = await fetch(url, {
          method: "POST",
          agent,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Calevid-Webhook/1.0",
            Accept: "application/json",
          },
          body: JSON.stringify({
            secret: String(WEBHOOK_SECRET).trim(),
            email: String(email).trim(),
            credits: Number(credits),
            reference: String(reference).trim(),
          }),
        });

        const text = await wpRes.text();
        log("✅ WordPress response:", wpRes.status, text);
      } catch (err) {
        log("❌ WordPress request failed:", err.name, err.message);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
);

/* =========================
   JSON PARSER
========================= */
app.use(express.json());

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
