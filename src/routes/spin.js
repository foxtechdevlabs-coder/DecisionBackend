import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requireParticipant } from "../middleware/auth.js";

export const spinRouter = Router();

const WHEEL_COLORS = ["#7C3AED", "#4C1D95", "#A855F7", "#2E1065", "#9333EA", "#3B0764", "#6D28D9"];

// GET /api/offers — public list for rendering the wheel. Weights are never exposed.
spinRouter.get("/offers", async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, offer_type, discount_percentage
     FROM offers
     WHERE is_active = TRUE AND (max_claims IS NULL OR claims_count < max_claims)
     ORDER BY id ASC`
  );

  const wheel = rows.map((offer, index) => ({
    id: offer.id,
    name: offer.name,
    offerType: offer.offer_type,
    discountPercentage: offer.discount_percentage,
    color: WHEEL_COLORS[index % WHEEL_COLORS.length],
  }));
  res.json({ success: true, offers: wheel });
});

// Equal probability across every active offer — no weighting. Each of N
// active offers has exactly a 1/N chance, decided here on the server.
function pickEqualChance(offers) {
  return offers[Math.floor(Math.random() * offers.length)];
}

// POST /api/spin — server determines the winner; frontend only animates to it.
//
// Postgres queries are async and genuinely interleave between concurrent
// requests (unlike the old synchronous SQLite version), so correctness here
// comes from real row locks: `SELECT ... FOR UPDATE` on both the
// participant row and the candidate offer rows means a second concurrent
// spin blocks until the first transaction commits, then sees the updated
// has_spun / claims_count and reacts correctly. `ORDER BY id` keeps lock
// acquisition order consistent across transactions to avoid deadlocks.
spinRouter.post("/spin", requireParticipant, async (req, res) => {
  const participantId = req.participantId;

  try {
    const { status, body } = await withTransaction(async (client) => {
      const { rows: participantRows } = await client.query(
        "SELECT * FROM participants WHERE id = $1 FOR UPDATE",
        [participantId]
      );
      const participant = participantRows[0];
      if (!participant) {
        return { status: 404, body: { success: false, message: "Participant not found." } };
      }

      if (participant.has_spun) {
        return {
          status: 200,
          body: {
            success: false,
            alreadySpun: true,
            message: "You have already participated in this offer campaign.",
            offer: {
              name: participant.offer_name,
              offerType: participant.offer_type,
              discountPercentage: participant.discount_percentage,
            },
          },
        };
      }

      const { rows: offers } = await client.query(
        `SELECT * FROM offers
         WHERE is_active = TRUE AND (max_claims IS NULL OR claims_count < max_claims)
         ORDER BY id
         FOR UPDATE`
      );

      if (offers.length === 0) {
        return {
          status: 503,
          body: { success: false, message: "No offers are available right now. Please try again later." },
        };
      }

      const winner = pickEqualChance(offers);

      await client.query(
        `UPDATE participants
         SET has_spun = TRUE, offer_id = $1, offer_name = $2, offer_type = $3, discount_percentage = $4, updated_at = NOW()
         WHERE id = $5`,
        [winner.id, winner.name, winner.offer_type, winner.discount_percentage, participantId]
      );

      await client.query("UPDATE offers SET claims_count = claims_count + 1 WHERE id = $1", [winner.id]);

      return {
        status: 200,
        body: {
          success: true,
          offer: {
            id: winner.id,
            name: winner.name,
            offerType: winner.offer_type,
            discountPercentage: winner.discount_percentage,
          },
        },
      };
    });

    res.status(status).json(body);
  } catch (err) {
    console.error("[spin] unexpected error", err);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
});
