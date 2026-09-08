import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { initDb } from "./db.js";
import { participantsRouter } from "./routes/participants.js";
import { spinRouter } from "./routes/spin.js";
import { adminRouter } from "./routes/admin.js";
import { couponsRouter } from "./routes/coupons.js";
import { vouchersRouter } from "./routes/vouchers.js";

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Copy .env.example to .env and configure it.");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json({ limit: "10kb" }));

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});

const spinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});

// Coupon codes (FT + 4 chars) and voucher codes are short enough to be
// guessable given unlimited attempts — these limiters are the mitigation,
// on top of the codes themselves never being predictable/sequential.
const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});

const voucherRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." },
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/participants/register", registerLimiter);
app.use("/api/spin", spinLimiter);
app.use("/api/admin/login", loginLimiter);
app.use("/api/coupons/validate", couponLimiter);
app.use(/^\/api\/vouchers\/[^/]+\/redeem$/, voucherRedeemLimiter);

app.use("/api/participants", participantsRouter);
app.use("/api", spinRouter);
app.use("/api/admin", adminRouter);
app.use("/api/coupons", couponsRouter);
app.use("/api/vouchers", vouchersRouter);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found." });
});

// Centralized error handler — never leak internals to the client.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error." });
});

try {
  await initDb();
  app.listen(PORT, () => {
    console.log(`FOXTECH backend listening on http://localhost:${PORT}`);
  });
} catch (err) {
  console.error("FATAL: Could not connect to the database.", err);
  process.exit(1);
}
