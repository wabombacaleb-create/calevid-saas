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
const WP_SITE_URL = (process.env.WP_SITE_URL || "").trim().replace(/\/+$/, "");

const httpsAgent = new https.Agent({
 keepAlive: false,
 rejectUnauthorized: true,
 family: 4,
});

fal.config({ credentials: process.env.FAL_KEY });
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ======================
// MIDDLEWARE
// ======================

// CORS (adjust origin as needed)
app.use(
 cors({
 origin: "*",
 methods: ["GET", "POST", "OPTIONS"],
 allowedHeaders: ["Content-Type", "x-paystack-signature"],
 })
);

// For all non-webhook JSON routes, if you add any later
app.use(express.json());

// ======================
// HEALTH CHECK
// ======================
app.get("/", (req, res) =>
 res.send({ status: "ok", time: new Date().toISOString() })
);

// ======================
// PAYSTACK WEBHOOK (raw body for signature)
// ======================
app.post(
 "/paystack-webhook",
 // Use raw body so HMAC gets the exact bytes Paystack sent
 express.raw({ type: "application/json" }),
 async (req, res) => {
 log("🔥 PAYSTACK WEBHOOK HIT");

 const secret = process.env.PAYSTACK_SECRET;
 const signature = req.headers["x-paystack-signature"];

 if (!secret) {
 log("❌ PAYSTACK_SECRET is not set in environment");
 return res.status(500).send("Server misconfigured");
 }

 if (!signature) {
 log("❌ Missing x-paystack-signature header");
 return res.status(400).send("Missing signature");
 }

 // req.body is a Buffer here – valid for Hmac.update
 let computed;
 try {
 computed = crypto
 .createHmac("sha512", secret)
 .update(req.body) // Buffer, NOT an object
 .digest("hex");
 } catch (err) {
 log("❌ Error computing HMAC:", err.message);
 return res.status(500).send("Error verifying signature");
 }

 if (computed !== signature) {
 log("❌ Invalid Paystack signature");
 return res.status(400).send("Invalid signature");
 }

 // Signature valid – parse JSON
 let event;
 try {
 const bodyString = req.body.toString("utf8");
 event = JSON.parse(bodyString);
 } catch (err) {
 log("❌ Failed to parse webhook JSON:", err.message);
 return res.status(400).send("Invalid JSON");
 }

 log(
 "✅ Verified Paystack event:",
 event.event,
 "reference:",
 event?.data?.reference
 );

 // TODO: your business logic here
 // Example placeholder:
 // if (event.event === "charge.success") {
 // // e.g., notify your WordPress backend:
 // if (WP_SITE_URL) {
 // try {
 // const wpRes = await fetch(`${WP_SITE_URL}/wp-json/calevid/v1/paystack`, {
 // method: "POST",
 // headers: { "Content-Type": "application/json" },
 // body: JSON.stringify(event),
 // agent: httpsAgent,
 // });
 // log("WP notify status:", wpRes.status);
 // } catch (e) {
 // log("Error notifying WP:", e.message);
 // }
 // }
 // }

 return res.sendStatus(200);
 }
);

// ======================
// START SERVER
// ======================
app.listen(PORT, () => {
 log(`🚀 Calevid backend running on port ${PORT}`);
});
