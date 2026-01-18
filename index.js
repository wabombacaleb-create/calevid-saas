import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import dns from "dns";
import { fal } from "@fal-ai/client";

// 🔧 FORCE IPV4 (Hostinger-safe)
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ CLEAN WORDPRESS URL
const WP_SITE_URL = (process.env.WP_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

// ======================
// HEALTH
// ======================
app.get("/", (_, res) => res.send("Calevid backend is running"));

app.get("/status/test", (_, res) => {
  log("Health check hit");
  res.json({ status: "ok" });
});

// ======================
// PAYSTACK WEBHOOK
// ======================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const body = req.body;
  const signature = req.headers["x-paystack-signature"];

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
    .update(body)
    .digest("hex");

  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(body.toString());
  } catch (err) {
    log("❌ Invalid JSON body", err);
    return res.sendStatus(400);
  }

  // ✅ IMMEDIATE ACK TO PAYSTACK
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  // ======================
  // ASYNC CREDIT APPLY
  // ======================
  setTimeout(async () => {
    try {
      const params = new URLSearchParams({
        secret: (process.env.CALEVID_WEBHOOK_SECRET || "").trim(),
        email,
        credits: String(credits),
        reference,
      });

      const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits?${params.toString()}`;

      log("Calling WordPress REST endpoint:", url);

      const wpRes = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Calevid-Webhook/1.0",
          "Accept": "application/json",
        },
        timeout: 15000, // ✅ node-fetch SAFE timeout
      });

      const text = await wpRes.text();

      log("✅ WordPress responded", {
        status: wpRes.status,
        body: text,
      });
    } catch (err) {
      log("❌ WordPress request failed", {
        name: err.name,
        message: err.message,
      });
    }
  }, 0);
});

// ======================
// VIDEO GENERATION
// ======================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Prompt required",
      });
    }

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    const videoUrl = result?.data?.video?.url;

    if (!videoUrl) {
      return res.status(500).json({
        status: "error",
        message: "Video failed",
      });
    }

    res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch (err) {
    log("❌ Video generation failed", err);
    res.status(500).json({
      status: "error",
      message: "Generation failed",
    });
  }
});

// ======================
// START SERVER
// ======================
app.listen(PORT, () =>
  log(`🚀 Calevid backend running on port ${PORT}`)
);
