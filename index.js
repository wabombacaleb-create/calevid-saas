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
const WP_SITE_URL = (process.env.WP_SITE_URL || "").trim().replace(/\/+$/, "");
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.CALEVID_WEBHOOK_SECRET || "";
const API_KEY = process.env.API_KEY || "";
const SAFE_MODE = process.env.SAFE_MODE === "true";

fal.config({
  credentials: process.env.FAL_KEY,
});

/* =========================
   GLOBALS
========================= */
const jobs = new Map();

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true,
  family: 4,
});

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());

app.use("/generate-video", (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

/* =========================
   HEALTH
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* =========================
   JOB STATUS
========================= */
app.get("/video-status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/* =========================
   PAYSTACK WEBHOOK
========================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const body = req.body;
    const signature = req.headers["x-paystack-signature"];

    if (!signature || !PAYSTACK_SECRET) return res.sendStatus(401);

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(body)
      .digest("hex");

    if (hash !== signature) return res.sendStatus(401);

    let event;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    if (event.event !== "charge.success") return;

    const { reference, customer, amount } = event.data || {};
    const email = (customer?.email || "").toLowerCase();
    const credits = Math.floor((amount || 0) / 100 / 150);

    if (!email || !reference || credits <= 0) return;

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;

    setImmediate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        await fetch(url, {
          method: "POST",
          agent: httpsAgent,
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: WEBHOOK_SECRET,
            email,
            credits,
            reference,
          }),
        });
      } catch (err) {
        log("Webhook error:", err.message);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
);

/* =========================
   VIDEO GENERATION
========================= */
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, testMode } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    /* =========================
       SAFE MODE / TEST MODE
    ========================= */
    if (SAFE_MODE || testMode === true) {
      const requestId = "test_" + Date.now();

      log("🧪 SAFE MODE ACTIVE — skipping Fal:", requestId);

      jobs.set(requestId, {
        status: "processing",
        prompt,
        testMode: true,
      });

      processVideo(requestId, prompt);

      return res.json({
        status: "processing",
        requestId,
        testMode: true,
      });
    }

    /* =========================
       REAL GENERATION
    ========================= */
    if (!process.env.FAL_KEY) {
      throw new Error("FAL_KEY missing");
    }

    const submit = await fal.queue.submit("fal-ai/ovi", {
      input: { prompt },
    });

    const requestId = submit?.request_id;
    if (!requestId) throw new Error("No request ID");

    jobs.set(requestId, {
      status: "processing",
      prompt,
    });

    processVideo(requestId, prompt);

    res.json({
      status: "processing",
      requestId,
    });

  } catch (err) {
    log("❌ Submit failed:", err.message);
    res.status(500).json({ error: "Failed to start generation" });
  }
});

/* =========================
   BACKGROUND PROCESSOR
========================= */
async function processVideo(requestId, prompt) {

  /* ===== SAFE MODE SIMULATION ===== */
  if (requestId.startsWith("test_")) {
    await sleep(5000);

    const fakeVideo =
      "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4";

    jobs.set(requestId, {
      status: "completed",
      videoUrl: fakeVideo,
      testMode: true,
    });

    log("🧪 Fake video ready:", fakeVideo);
    return;
  }

  /* ===== REAL FLOW ===== */
  const MAX_ATTEMPTS = 30;
  let attempts = 0;
  let result = null;

  try {
    while (attempts < MAX_ATTEMPTS) {
      attempts++;

      const status = await retry(() =>
        fal.queue.status("fal-ai/ovi", { requestId })
      );

      jobs.set(requestId, {
        ...jobs.get(requestId),
        status: status.status.toLowerCase(),
      });

      if (status.status === "COMPLETED") {
        result = await retry(() =>
          fal.queue.result("fal-ai/ovi", { requestId })
        );
        break;
      }

      if (status.status === "FAILED") {
        throw new Error("Generation failed");
      }

      await sleep(Math.min(4000 + attempts * 500, 10000));
    }

    if (!result) throw new Error("Timeout");

    const videoUrl =
      result?.data?.video?.url ||
      result?.data?.outputs?.[0]?.video?.url ||
      result?.video?.url ||
      result?.outputs?.[0]?.video?.url;

    if (!videoUrl) throw new Error("No video URL");

    jobs.set(requestId, {
      status: "completed",
      videoUrl,
    });

    await saveToWordPress(prompt, videoUrl);

  } catch (err) {
    jobs.set(requestId, {
      status: "failed",
      error: err.message,
    });

    log("❌ Job failed:", err.message);
  }
}

/* =========================
   WORDPRESS SAVE
========================= */
async function saveToWordPress(prompt, videoUrl) {
  if (!WP_SITE_URL || !WEBHOOK_SECRET) return;

  const url = `${WP_SITE_URL}/wp-json/calevid/v1/save-video`;

  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: WEBHOOK_SECRET,
          prompt,
          videoUrl,
        }),
      });

      if (!res.ok) throw new Error("WP failed");
      log("✅ Video saved to WP");
      return;

    } catch (err) {
      log("WP retry:", err.message);
      await sleep(3000);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* =========================
   HELPERS
========================= */
async function retry(fn, retries = 3) {
  try {
    return await fn();
  } catch (err) {
    if (retries === 0) throw err;
    await sleep(2000);
    return retry(fn, retries - 1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  log(`🚀 Server running on port ${PORT}`);
});