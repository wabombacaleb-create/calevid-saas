import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Fal from "@fal-ai/client"; // Make sure Fal.ai client is installed

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// =================================================
// ✅ HEALTH CHECK
// =================================================
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

app.get("/status/test", (req, res) => {
  res.json({ status: "Node backend is running" });
});

// =================================================
// ✅ PAYSTACK PAYMENT VERIFICATION
// =================================================
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;
  if (!reference) {
    return res.status(400).json({ status: "error", message: "Payment reference is required" });
  }

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();
    console.log("PAYSTACK VERIFY RESPONSE:", result);

    if (result.status && result.data.status === "success") {
      return res.json({
        status: "success",
        message: "Payment verified successfully",
        data: {
          amount: result.data.amount,
          currency: result.data.currency,
          customer: result.data.customer.email,
          reference: result.data.reference,
        },
      });
    } else {
      return res.status(400).json({
        status: "failed",
        message: "Payment not successful",
        data: result.data,
      });
    }
  } catch (error) {
    console.error("VERIFY PAYMENT ERROR:", error);
    return res.status(500).json({ status: "error", message: "Server error verifying payment" });
  }
});

// =================================================
// ✅ VIDEO GENERATION VIA FAL.AI / OVI AI
// =================================================
app.post("/generate-video", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ status: "error", message: "Prompt is required" });
  }

  console.log("VIDEO PROMPT RECEIVED:", prompt);

  try {
    // Configure Fal.ai client
    const fal = new Fal({
      credentials: process.env.FAL_KEY, // Fal.ai API key
    });

    // Generate video with Ovi AI
    const video = await fal.video.create({
      model: "fal-ai/ovi",
      prompt: prompt,
      resolution: "720p",
    });

    console.log("VIDEO GENERATED:", video);

    res.json({
      status: "success",
      message: "Video generated successfully",
      videoUrl: video.output[0].url, // returned video URL
    });
  } catch (error) {
    console.error("FAL.AI VIDEO ERROR:", error);
    res.status(500).json({
      status: "error",
      message: "Fal.ai video generation failed",
      error: error.message,
    });
  }
});

// =================================================
// ✅ START SERVER
// =================================================
app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
