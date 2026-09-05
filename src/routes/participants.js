import { Router } from "express";
import { query } from "../db.js";
import { normalizePhone, isValidPhone } from "../utils/phone.js";
import { signParticipantToken } from "../middleware/auth.js";

export const participantsRouter = Router();

const DEPARTMENTS = new Set([
  "Computer Science / IT",
  "AI & Data Science",
  "Electronics",
  "Electrical",
  "Mechanical",
  "Civil",
  "Management",
  "Commerce",
  "Other",
]);

const YEARS = new Set(["1st Year", "2nd Year", "3rd Year", "4th Year", "Final Year", "Graduated / Professional"]);

function cleanName(rawName) {
  return String(rawName || "").trim().replace(/\s+/g, " ");
}

// The phone number is the sole identity key for "has this person already
// participated" — name and department are stored for record-keeping but no
// longer affect duplicate detection (see backend/.env.example / README).
async function findExisting(normalizedPhone) {
  const { rows } = await query("SELECT * FROM participants WHERE normalized_phone = $1", [normalizedPhone]);
  return rows[0] || null;
}

function toPublicOffer(row) {
  if (!row || !row.has_spun) return null;
  return { name: row.offer_name, offerType: row.offer_type, discountPercentage: row.discount_percentage };
}

participantsRouter.post("/register", async (req, res) => {
  const name = cleanName(req.body?.name);
  const phoneRaw = String(req.body?.phone || "").trim();
  const department = String(req.body?.department || "").trim();
  const departmentOther = cleanName(req.body?.departmentOther);
  const year = String(req.body?.year || "").trim();
  const collegeName = cleanName(req.body?.collegeName);

  if (!name || name.length < 2) {
    return res.status(400).json({ success: false, message: "Please enter your full name." });
  }
  if (!phoneRaw || !isValidPhone(phoneRaw)) {
    return res.status(400).json({ success: false, message: "Please enter a valid phone number." });
  }
  if (!department || !DEPARTMENTS.has(department)) {
    return res.status(400).json({ success: false, message: "Please select a valid department." });
  }
  if (department === "Other" && (!departmentOther || departmentOther.length < 2)) {
    return res.status(400).json({ success: false, message: "Please specify your department." });
  }
  if (!year || !YEARS.has(year)) {
    return res.status(400).json({ success: false, message: "Please select a valid year." });
  }
  if (!collegeName || collegeName.length < 2) {
    return res.status(400).json({ success: false, message: "Please enter your college name." });
  }

  const normalizedPhone = normalizePhone(phoneRaw);

  try {
    const existing = await findExisting(normalizedPhone);
    if (existing) {
      if (existing.has_spun) {
        return res.status(200).json({
          success: false,
          alreadyParticipated: true,
          alreadySpun: true,
          message: "You've already claimed your offer! You have already participated in this offer campaign.",
          offer: toPublicOffer(existing),
        });
      }
      // Registered previously but hasn't spun yet (e.g. refreshed the page) — resume, don't duplicate.
      return res.status(200).json({
        success: true,
        participantId: existing.id,
        token: signParticipantToken(existing.id),
        canSpin: true,
        resumed: true,
      });
    }

    // ON CONFLICT DO NOTHING makes the duplicate-phone race safe without a
    // try/catch: if another request inserted the same phone number first,
    // this returns zero rows instead of erroring, and we just re-fetch it.
    const { rows } = await query(
      `INSERT INTO participants (name, phone, normalized_phone, department, department_other, year, college_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (normalized_phone) DO NOTHING
       RETURNING *`,
      [name, phoneRaw, normalizedPhone, department, department === "Other" ? departmentOther : null, year, collegeName]
    );

    if (rows.length === 0) {
      const raceExisting = await findExisting(normalizedPhone);
      return res.status(200).json({
        success: false,
        alreadyParticipated: true,
        alreadySpun: Boolean(raceExisting?.has_spun),
        message: raceExisting?.has_spun
          ? "You've already claimed your offer! You have already participated in this offer campaign."
          : "You're already registered for this campaign.",
        offer: toPublicOffer(raceExisting),
      });
    }

    const created = rows[0];
    return res.status(201).json({
      success: true,
      participantId: created.id,
      token: signParticipantToken(created.id),
      canSpin: true,
    });
  } catch (err) {
    console.error("[participants/register] unexpected error", err);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});

export const DEPARTMENT_LIST = Array.from(DEPARTMENTS);
