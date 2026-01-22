import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import dns from "dns";
import { fal } from "@fal-ai/client";

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   CONFIG
========================= */
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.CALEVID_WEBHOOK_SECRET;

fal.config({
  credentials: process.env.FAL_KEY,
});

/* =========================
   GLOBAL MIDDLEWARE
========================= */
app.use(cors());

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
    console.log("🔥 PAYSTACK WEBHOOK HIT");

    const body = req.body;
    const signature = req.headers["x-paystack-signature"];

    if (!signature || !PAYSTACK_SECRET) {
      console.log("❌ Missing Paystack signature or secret");
      return res.sendStatus(401);
    }

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(body)
      .digest("hex");

    if (hash !== signature) {
      console.log("❌ Invalid Paystack signature");
      return res.sendStatus(401);
    }

    let event;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch (e) {
      console.log("❌ Failed to parse webhook body", e.message);
      return res.sendStatus(400);
    }

    console.log(
      "🔔 Paystack event:",
      event?.event,
      "status:",
      event?.data?.status
    );

    // ACK PAYSTACK IMMEDIATELY
    res.sendStatus(200);

    if (event.event !== "charge.success" || event.data?.status !== "success") {
      return;
    }

    const { reference, customer, amount } = event.data || {};
    const email = (customer?.email || "").trim();
    const credits = Math.floor((amount || 0) / 100 / 150);

    if (!email || !reference || !credits || credits <= 0) {
      console.log("⚠️ Invalid credit data", { email, reference, credits });
      return;
    }

    console.log("Processing credits", { email, credits, reference });

    if (!WEBHOOK_SECRET) {
      console.log("❌ Missing CALEVID_WEBHOOK_SECRET");
      return;
    }

    // 🔥 IMPORTANT: HTTP, not HTTPS (Hostinger requirement)
    const wpUrl = "http://calevid.com/wp-json/calevid/v1/apply-credits";

    console.log("Calling WordPress:", wpUrl);
    console.log("Webhook secret:", `"${WEBHOOK_SECRET}"`);

    setImmediate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const wpRes = await fetch(wpUrl, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Calevid-Webhook/1.0",
            Accept: "application/json",
          },
          body: JSON.stringify({
            secret: WEBHOOK_SECRET,
            email,
            credits,
            reference,
          }),
        });

        const text = await wpRes.text();
        console.log("✅ WordPress responded", wpRes.status, text);
      } catch (err) {
        console.log("❌ WordPress request failed", err);
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
   VIDEO GENERATION
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
