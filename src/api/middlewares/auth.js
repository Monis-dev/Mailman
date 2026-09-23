import dotenv from "dotenv";
import crypto from "node:crypto"

dotenv.config();

async function Authorize(req, res, next) {
  try {
    const authHeader = req.headers["authorization"];
    const expected = Buffer.from(`Bearer ${process.env.RELAY_API_KEY}`);
    const received = Buffer.from(authHeader || "");
    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res
        .status(401)
        .json({ error: "Unauthorized: Invalid or missing API key" });
    }
    next();
  } catch (error) {
    console.log("API key is missing");
    res.status(401).json({ error: "Unauthorized: Invalid or missing API key" });
  }
}

export default Authorize