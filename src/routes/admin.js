import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, withTransaction } from "../db.js";
import { requireAdmin, signAdminToken } from "../middleware/auth.js";

export const adminRouter = Router();

adminRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  const { rows } = await query("SELECT * FROM admins WHERE email = $1", [email]);
  const admin = rows[0];
  const passwordMatches = admin ? bcrypt.compareSync(password, admin.password_hash) : false;

  if (!admin || !passwordMatches) {
    return res.status(401).json({ success: false, message: "Invalid email or password." });
  }

  return res.json({
    success: true,
    token: signAdminToken(admin.id, admin.email),
    admin: { email: admin.email, role: admin.role },
  });
});

adminRouter.get("/stats", requireAdmin, async (_req, res) => {
  const [{ rows: totalRows }, { rows: spinRows }, { rows: todayRows }, { rows: breakdownRows }] = await Promise.all([
    query("SELECT COUNT(*)::int AS c FROM participants"),
    query("SELECT COUNT(*)::int AS c FROM participants WHERE has_spun = TRUE"),
    query("SELECT COUNT(*)::int AS c FROM participants WHERE created_at::date = CURRENT_DATE"),
    query(
      `SELECT offer_name AS name, COUNT(*)::int AS count
       FROM participants
       WHERE has_spun = TRUE
       GROUP BY offer_name
       ORDER BY count DESC`
    ),
  ]);

  res.json({
    success: true,
    stats: {
      totalParticipants: totalRows[0].c,
      totalSpins: spinRows[0].c,
      offersDistributed: spinRows[0].c,
      todaysParticipants: todayRows[0].c,
      mostCommonOffer: breakdownRows[0]?.name || null,
      offerBreakdown: breakdownRows,
    },
  });
});

function toAdminOffer(row) {
  return {
    id: row.id,
    name: row.name,
    offerType: row.offer_type,
    discountPercentage: row.discount_percentage,
    weight: row.weight,
    isActive: Boolean(row.is_active),
    maxClaims: row.max_claims,
    claimsCount: row.claims_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Validates and normalizes the subset of offer fields present in `body`,
// producing a { column: value } map ready to interpolate into a dynamic
// SET/INSERT clause with positional ($1, $2, ...) params.
// `partial` (used for PUT) only requires fields that were actually sent.
// `offerType` is resolved by the caller (it may come from `body` or fall
// back to the existing row on a partial update) because whether
// discountPercentage is required depends on it.
function parseOfferInput(body, { partial, offerType }) {
  const errors = [];
  const out = {};

  if (!partial || body.offerType !== undefined) {
    out.offer_type = offerType;
  }

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) errors.push(offerType === "custom" ? "Reward text is required." : "Name is required.");
    out.name = name;
  }

  const discountTouched = !partial || body.discountPercentage !== undefined || body.offerType !== undefined;
  if (discountTouched) {
    if (offerType === "custom") {
      out.discount_percentage = null;
    } else {
      const discount = Number(body.discountPercentage);
      if (!Number.isInteger(discount) || discount < 1 || discount > 100) {
        errors.push("Discount percentage must be a whole number between 1 and 100.");
      }
      out.discount_percentage = discount;
    }
  }

  if (!partial || body.weight !== undefined) {
    const weight = Number(body.weight);
    if (!Number.isInteger(weight) || weight < 0) {
      errors.push("Weight must be a whole number of 0 or more.");
    }
    out.weight = weight;
  }

  if (!partial || body.maxClaims !== undefined) {
    if (body.maxClaims === null || body.maxClaims === "" || body.maxClaims === undefined) {
      out.max_claims = null;
    } else {
      const maxClaims = Number(body.maxClaims);
      if (!Number.isInteger(maxClaims) || maxClaims < 0) {
        errors.push("Max claims must be a whole number of 0 or more, or left blank.");
      }
      out.max_claims = maxClaims;
    }
  }

  if (!partial || body.isActive !== undefined) {
    out.is_active = Boolean(body.isActive);
  }

  return { errors, values: out };
}

// GET /api/admin/offers — full offer list for the wheel-content editor (weights included).
adminRouter.get("/offers", requireAdmin, async (_req, res) => {
  const { rows } = await query("SELECT * FROM offers ORDER BY id ASC");
  res.json({ success: true, offers: rows.map(toAdminOffer) });
});

adminRouter.post("/offers", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const offerType = body.offerType === "custom" ? "custom" : "percentage";
  const { errors, values } = parseOfferInput(body, { partial: false, offerType });
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0] });
  }

  const { rows } = await query(
    `INSERT INTO offers (name, offer_type, discount_percentage, weight, max_claims, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [values.name, values.offer_type, values.discount_percentage, values.weight, values.max_claims, values.is_active]
  );

  res.status(201).json({ success: true, offer: toAdminOffer(rows[0]) });
});

adminRouter.put("/offers/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: existingRows } = await query("SELECT * FROM offers WHERE id = $1", [id]);
  const existing = existingRows[0];
  if (!existing) {
    return res.status(404).json({ success: false, message: "Offer not found." });
  }

  const body = req.body || {};
  const offerType = body.offerType !== undefined ? (body.offerType === "custom" ? "custom" : "percentage") : existing.offer_type;
  const { errors, values } = parseOfferInput(body, { partial: true, offerType });
  if (values.max_claims != null && values.max_claims < existing.claims_count) {
    errors.push(`Max claims can't be lower than the ${existing.claims_count} already distributed.`);
  }
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0] });
  }

  const fields = Object.keys(values);
  if (fields.length === 0) {
    return res.json({ success: true, offer: toAdminOffer(existing) });
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const params = fields.map((f) => values[f]);
  params.push(id);

  const { rows } = await query(
    `UPDATE offers SET ${setClause}, updated_at = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
    params
  );

  res.json({ success: true, offer: toAdminOffer(rows[0]) });
});

adminRouter.delete("/offers/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const force = req.query.force === "true";
  const { rows: existingRows } = await query("SELECT * FROM offers WHERE id = $1", [id]);
  const existing = existingRows[0];
  if (!existing) {
    return res.status(404).json({ success: false, message: "Offer not found." });
  }
  if (existing.claims_count > 0 && !force) {
    return res.status(409).json({
      success: false,
      alreadyWon: true,
      claimsCount: existing.claims_count,
      message: "This offer has already been won by participants and can't be deleted — disable it instead.",
    });
  }

  await withTransaction(async (client) => {
    if (existing.claims_count > 0) {
      // Participants keep their snapshotted offer_name/discount_percentage —
      // only the now-dangling foreign key to the deleted offer is cleared.
      await client.query("UPDATE participants SET offer_id = NULL WHERE offer_id = $1", [id]);
    }
    await client.query("DELETE FROM offers WHERE id = $1", [id]);
  });

  res.json({ success: true, unlinkedParticipants: existing.claims_count });
});

adminRouter.get("/participants", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const search = String(req.query.search || "").trim();
  const department = String(req.query.department || "").trim();
  const offer = String(req.query.offer || "").trim();

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  if (department) {
    params.push(department);
    conditions.push(`department = $${params.length}`);
  }
  if (offer) {
    params.push(offer);
    conditions.push(`offer_name = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS c FROM participants ${whereClause}`, params);

  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;
  const { rows } = await query(
    `SELECT id, name, phone, department, department_other, year, college_name, has_spun, offer_name, offer_type, discount_percentage, created_at
     FROM participants
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  res.json({
    success: true,
    total: countRows[0].c,
    page,
    pageSize,
    participants: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      department: row.department === "Other" && row.department_other ? `Other (${row.department_other})` : row.department,
      year: row.year,
      collegeName: row.college_name,
      status: row.has_spun ? "Spun" : "Registered",
      offer: row.has_spun
        ? { name: row.offer_name, offerType: row.offer_type, discountPercentage: row.discount_percentage }
        : null,
      createdAt: row.created_at,
    })),
  });
});
