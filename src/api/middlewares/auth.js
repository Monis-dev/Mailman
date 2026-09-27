// Middleware to verify incoming API requests using a secret Bearer token.

import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();

async function Authorize(req, res, next) {
  try {
    // Grab the Authorization header from the incoming request
    const authHeader = req.headers["authorization"];
    // Convert both keys into byte buffers so we can safely compare them
    const expected = Buffer.from(`Bearer ${process.env.RELAY_API_KEY}`);
    const received = Buffer.from(authHeader || "");
    // Use timingSafeEqual to prevent timing attacks.
    // Both buffers must be the same length before comparing.
    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res
        .status(401)
        .json({ error: "Unauthorized: Invalid or missing API key" });
    }
    // Token is valid, proceed to the next middleware or route handler
    next();
  } catch (error) {
    // Block access if any check fails or environment variable is missing
    console.log("API key is missing");
    res.status(401).json({ error: "Unauthorized: Invalid or missing API key" });
  }
}

export default Authorize;
