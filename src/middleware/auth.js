import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

export function signParticipantToken(participantId) {
  return jwt.sign({ sub: participantId, type: "participant" }, JWT_SECRET, {
    expiresIn: "2h",
  });
}

export function signAdminToken(adminId, email) {
  return jwt.sign({ sub: adminId, email, type: "admin" }, JWT_SECRET, {
    expiresIn: "8h",
  });
}

function extractToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

export function requireParticipant(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Missing or invalid session." });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "participant") throw new Error("wrong token type");
    req.participantId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Session expired or invalid." });
  }
}

export function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "admin") throw new Error("wrong token type");
    req.admin = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired admin session." });
  }
}
