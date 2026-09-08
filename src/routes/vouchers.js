import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const vouchersRouter = Router();

function normalizeCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function toPublicVoucher(v) {
  return {
    tier: v.tier,
    status: v.status,
    rewardText: v.status === "REDEEMED" ? v.reward_text : null,
    createdAt: v.created_at,
    redeemedAt: v.redeemed_at,
  };
}

// GET /api/vouchers/:code — loads the scratch-card page state. Never reveals
// a reward for an unredeemed voucher; the frontend keeps the card hidden
// until the user actually scratches, which calls /redeem below.
vouchersRouter.get("/:code", asyncHandler(async (req, res) => {
  const code = normalizeCode(req.params.code);
  const { rows } = await query("SELECT * FROM vouchers WHERE voucher_code = $1", [code]);
  const voucher = rows[0];

  if (!voucher) {
    return res.status(404).json({ success: false, message: "This voucher does not exist." });
  }

  res.json({ success: true, voucher: toPublicVoucher(voucher) });
}));

// POST /api/vouchers/:code/redeem — the scratch action. The reward is
// chosen here, on the server, from that tier's active reward pool — the
// frontend only ever displays what this endpoint returns. A row lock on
// the voucher makes the AVAILABLE -> REDEEMED transition atomic, so two
// near-simultaneous scratches of the same code can't both win a reward.
vouchersRouter.post("/:code/redeem", asyncHandler(async (req, res) => {
  const code = normalizeCode(req.params.code);

  const { rows: existingRows } = await query("SELECT * FROM vouchers WHERE voucher_code = $1", [code]);
  if (!existingRows[0]) {
    return res.status(404).json({ success: false, message: "This voucher does not exist." });
  }

  const { status, body } = await withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM vouchers WHERE voucher_code = $1 FOR UPDATE", [code]);
    const voucher = rows[0];

    if (voucher.status === "REDEEMED") {
      return {
        status: 200,
        body: {
          success: false,
          alreadyRedeemed: true,
          message: "This voucher has already been redeemed.",
          reward: voucher.reward_text,
        },
      };
    }

    const { rows: prizeRows } = await client.query(
      "SELECT * FROM voucher_prizes WHERE tier = $1 AND is_active = TRUE",
      [voucher.tier]
    );

    if (prizeRows.length === 0) {
      return {
        status: 503,
        body: { success: false, message: "No rewards are configured for this tier right now. Please try again later." },
      };
    }

    const reward = prizeRows[Math.floor(Math.random() * prizeRows.length)];

    await client.query(
      `UPDATE vouchers SET status = 'REDEEMED', reward_id = $1, reward_text = $2, redeemed_at = NOW()
       WHERE voucher_code = $3`,
      [reward.id, reward.reward_text, code]
    );

    return { status: 200, body: { success: true, reward: reward.reward_text, tier: voucher.tier } };
  });

  res.status(status).json(body);
}));
