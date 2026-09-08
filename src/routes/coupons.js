import { Router } from "express";
import { query } from "../db.js";
import { signParticipantToken } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const couponsRouter = Router();

function normalizeCouponInput(raw) {
  return String(raw || "").trim().toUpperCase();
}

function toPublicOffer(row) {
  if (!row || !row.has_spun) return null;
  return { name: row.offer_name, offerType: row.offer_type, discountPercentage: row.discount_percentage };
}

// POST /api/coupons/validate — the front door for the Instagram decision
// wheel: a coupon earned at registration (possibly on a different device)
// is exchanged here for the same participant JWT the direct post-register
// flow already uses, so the rest of the wheel (WheelPage, /api/spin) needs
// no changes at all to support "enter my code later" as an entry path.
couponsRouter.post("/validate", asyncHandler(async (req, res) => {
  const couponCode = normalizeCouponInput(req.body?.couponCode);

  if (!couponCode) {
    return res.status(400).json({ success: false, message: "Please enter your coupon code." });
  }

  const { rows } = await query("SELECT * FROM participants WHERE coupon_code = $1", [couponCode]);
  const participant = rows[0];

  if (!participant) {
    return res.status(404).json({ success: false, message: "Invalid coupon code." });
  }

  if (participant.has_spun) {
    return res.status(200).json({
      success: false,
      alreadySpun: true,
      message: "This coupon has already been used.",
      offer: toPublicOffer(participant),
    });
  }

  return res.json({
    success: true,
    participantId: participant.id,
    token: signParticipantToken(participant.id),
    canSpin: true,
    name: participant.name,
  });
}));
