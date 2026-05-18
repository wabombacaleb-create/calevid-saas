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
const API_KEY = process.env.API_KEY || "";

fal.config({
  credentials: process.env.FAL_KEY,
});

const SAFE_MODE = String(process.env.SAFE_MODE).toLowerCase() === "true";

console.log("ENV SAFE_MODE:", process.env.SAFE_MODE);
console.log("PARSED SAFE_MODE:", SAFE_MODE);

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

    // validate signature
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
      log("❌ Failed to parse webhook body:", e.message);
      return res.sendStatus(400);
    }

    log("🔔 Paystack event:", event?.event, event?.data?.status);

    // acknowledge immediately
    res.sendStatus(200);

    // only successful charges
    if (event.event !== "charge.success") return;
    if (event.data?.status !== "success") return;

    const metadataType = event.data?.metadata?.type || "";

    log("PAYSTACK METADATA:", JSON.stringify(event.data?.metadata));

    /*
      IMPORTANT:
      ONLY process Buy Credits.
      WordPress handles all subscriptions.
    */
    if (metadataType !== "credits") {
      log("⏭ Non-credit payment ignored (handled by WordPress)");
      return;
    }

    const { reference, customer, amount } = event.data || {};
    const email = (customer?.email || "").trim().toLowerCase();

    // 150 KES = 1 credit
    const credits = Math.floor((amount || 0) / 100 / 150);

    if (!email || !reference || credits <= 0) {
      log("❌ Invalid credit payload");
      return;
    }

    if (!WP_SITE_URL || !WEBHOOK_SECRET) {
      log("❌ Missing WP config");
      return;
    }

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;

    setImmediate(async () => {
      try {
        const bodyParams = new URLSearchParams({
          secret: WEBHOOK_SECRET,
          email,
          credits: String(credits),
          reference,
        });

        const response = await fetch(url, {
          method: "POST",
          agent: httpsAgent,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: bodyParams,
        });

        const result = await response.text();

        log(`✅ Credits applied: ${email} => ${credits}`);
        log("WP response:", result);

      } catch (err) {
        log("❌ WP credits failed:", err.message);
      }
    });
  }
);
/* =========================
   JSON PARSER (DO NOT MOVE)
========================= */
app.use(express.json());

/* =========================
   VIDEO GENERATION
========================= */
// Generate video
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, testMode } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    if (SAFE_MODE || testMode === true) {
      const requestId = "test_" + Date.now();
      return res.json({ status: "processing", requestId });
    }

    const submit = await fal.queue.submit("fal-ai/ovi", { input: { prompt } });
    const requestId = submit?.request_id;
    if (!requestId) throw new Error("No request_id returned from Fal");

    res.json({ status: "processing", requestId });
  } catch (err) {
    console.error("❌ Submit failed:", err.message);
    res.status(500).json({ error: "Failed to start generation" });
  }
});

// Status
app.get("/video-status/:id", async (req, res) => {
  const requestId = req.params.id;
  try {
    if (requestId.startsWith("test_")) {
      const createdAt = parseInt(requestId.split("_")[1], 10);
      const elapsed = Date.now() - createdAt;
      if (elapsed > 5000) return res.json({
        status: "completed",
        videoUrl: "https://calevid-saas-8.onrender.com/video.mp4"
      });
      return res.json({ status: "processing" });
    }

    const result = await fal.queue.result("fal-ai/ovi", { requestId });
    const videoUrl = result?.data?.video?.url || result?.data?.outputs?.[0]?.video?.url;
    if (videoUrl) return res.json({ status: "completed", videoUrl });
    return res.json({ status: "processing" });
  } catch { return res.json({ status: "processing" }); }
});

// SAFE_MODE video endpoint
app.get("/video.mp4", async (req, res) => {
  try {
    const response = await fetch("https://www.w3schools.com/html/mov_bbb.mp4");
    if (!response.ok) return res.status(500).send("Failed to fetch test video");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.body.pipe(res);
  } catch (err) {
    console.error("Video test error:", err.message);
    res.status(500).send("Video test failed");
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});