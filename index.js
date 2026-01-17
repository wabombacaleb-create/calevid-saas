import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";

const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");

app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => res.send("Calevid backend is running"));
app.get("/status/test", (req, res) => {
  log("Health check hit");
  res.json({ status: "ok" });
});

// =================================================
// PAYSTACK WEBHOOK
// =================================================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const bodyBuffer = req.body;
  const signature = req.headers["x-paystack-signature"];

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const hash = crypto
    .createHmac("sha512", secret)
    .update(bodyBuffer)
    .digest("hex");

  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(bodyBuffer.toString());
  } catch {
    return res.sendStatus(400);
  }

  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  log("Webhook event received charge.success");

  const { reference, customer, amount } = event.data;
  const email = customer?.email;
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) {
    log("Invalid credit data");
    return;
  }

  log("Processing credits", { email, credits, reference });

  setImmediate(async () => {
    try {
      const url =
        `${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`;

      log("Calling WordPress:", url);

      const wpRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: process.env.CALEVID_WEBHOOK_SECRET,
          email,
          credits: String(credits),
          reference,
        }),
      });

      const text = await wpRes.text();

      log("✅ WordPress response", {
        status: wpRes.status,
        body: text,
      });
    } catch (err) {
      log("❌ WordPress request failed", err.message);
    }
  });
});

// =================================================
// VIDEO GENERATION (UNCHANGED)
// =================================================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt)
      return res.status(400).json({ status: "error", message: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl)
      return res.status(500).json({ status: "error", message: "Video failed" });

    return res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch {
    return res.status(500).json({ status: "error", message: "Generation failed" });
  }
});

app.listen(PORT, () =>
  log(`🚀 Calevid backend running on port ${PORT}`)
);
