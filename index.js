import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";

// =================================================
// CONFIG
// =================================================
const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = process.env.WP_SITE_URL;

// =================================================
// MIDDLEWARE
// =================================================
app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// =================================================
// FAL.AI CONFIG
// =================================================
fal.config({ credentials: process.env.FAL_KEY });

// =================================================
// LOGGING
// =================================================
function logWebhook(message, data = {}) {
  const logDir = path.resolve("./logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const logFile = path.join(logDir, "paystack_webhook.log");
  fs.appendFileSync(
    logFile,
    `${new Date().toISOString()} - ${message} - ${JSON.stringify(data)}\n`
  );
}

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => res.send("Calevid backend is running"));
app.get("/status/test", (req, res) =>
  res.json({ status: "Node backend is running" })
);

// =================================================
// PAYSTACK WEBHOOK (FIXED)
// =================================================
app.post("/paystack-webhook", (req, res) => {
  const bodyBuffer = req.body;
  const bodyString = bodyBuffer.toString();

  const TEST_BYPASS = process.env.TEST_WEBHOOK_BYPASS === "true";

  if (!TEST_BYPASS) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.sendStatus(500);

    const signature = req.headers["x-paystack-signature"] || "";
    const hash = crypto
      .createHmac("sha512", secret)
      .update(bodyBuffer)
      .digest("hex");

    if (hash !== signature) {
      logWebhook("Invalid signature", {});
      return res.sendStatus(401);
    }
  }

  let event;
  try {
    event = JSON.parse(bodyString);
  } catch {
    return res.sendStatus(400);
  }

  // ✅ IMMEDIATE ACK TO PAYSTACK (CRITICAL FIX)
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const data = event.data;
  const reference = data.reference;
  const email = data.customer?.email;
  const amountKes = data.amount / 100;

  const credits = Math.floor(amountKes / 150);
  if (!email || credits <= 0) return;

  // ✅ ASYNC WORDPRESS CREDIT APPLICATION
  setImmediate(async () => {
    try {
      const wpRes = await fetch(
        `${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            secret: process.env.CALEVID_WEBHOOK_SECRET || "",
            email,
            credits: String(credits),
            reference,
          }),
          timeout: 5000,
        }
      );

      const wpText = await wpRes.text();

      logWebhook("Credits applied", {
        reference,
        email,
        credits,
        status: wpRes.status,
        response: wpText,
      });
    } catch (err) {
      logWebhook("WP async error", { error: err.message });
    }
  });
});

// =================================================
// VERIFY PAYMENT (UNCHANGED)
// =================================================
app.post("/verify-payment", (req, res) => {
  const { reference } = req.body;
  if (!reference)
    return res.status(400).json({ status: "error", message: "Reference required" });

  return res.json({
    status: "pending",
    message: "Payment received, awaiting credit",
    reference,
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
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Generation failed" });
  }
});

// =================================================
// START
// =================================================
app.listen(PORT, () =>
  console.log(`Calevid backend running on port ${PORT}`)
);
