import dotenv from "dotenv";

dotenv.config();

async function Authorize(req, res, next) {
  try {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${process.env.RELAY_API_KEY}`) {
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