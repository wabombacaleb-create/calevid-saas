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

const WP_SITE_URL = (process.env.WP_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const httpsAgent = new https.Agent({
  keepAlive: false,          // IMPORTANT: avoid hanging sockets
  rejectUnauthorized: true,
  family: 4,
});

app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

// ======================
// HEALTH
// ======================
app.get("/", (req, res) => res.send("Calevid backend is running"));

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
  } catch {
    return res.sendStatus(400);
  }

  res.sendStatus(200); // respond immediately

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  setImmediate(async () => {
    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    log("Calling WordPress REST endpoint:", url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const wpRes = await fetch(url, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Calevid-Webhook/1.0",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          secret: process.env.CALEVID_WEBHOOK_SECRET,
          email,
          credits,
          reference,
        }),
      });

      const text = await wpRes.text();
      log("✅ WordPress responded", wpRes.status, text);
    } catch (err) {
      log("❌ WordPress request failed", err.name, err.message);
    } finally {
      clearTimeout(timeout);
    }
  });
});

// ======================
// VIDEO GENERATION
// ======================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    res.json({
      status: "success",
      videoUrl: result?.data?.video?.url,
    });
  } catch (err) {
    res.status(500).json({ error: "Generation failed" });
  }
});

app.listen(PORT, () =>
  log(`🚀 Calevid backend running on port ${PORT}`)
);
