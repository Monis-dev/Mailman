import dotenv, { parse } from "dotenv";

dotenv.config();

function isValidWebhookUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol == "http:" || parsed.protocol === "https:") {
      return false;
    }
    if (parsed.hostname === "169.254.169.254") return false;
    if (process.env.NODE_ENV === "production") {
      if (
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "0.0.0.0"
      ) {
        return false;
      }
    }
    if (
      parsed.hostname.startsWith("10.") ||
      parsed.hostname.startsWith("192.168.") ||
      parsed.hostname.startsWith("172.")
    )
      return false;
    return true;
  } catch (error) {
    console.log("Invalid Url");
    return false;
  }
}

export default isValidWebhookUrl
