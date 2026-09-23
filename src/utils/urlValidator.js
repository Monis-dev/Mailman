import dotenv from "dotenv";
import dns from "node:dns/promises";

dotenv.config();

async function isValidWebhookUrl(urlString) {
  try {
    const { hostname, protocol } = new URL(urlString);
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address: ip } of addresses) {
      if (
        ip === "169.254.169.254" ||
        ip === "0.0.0.0" ||
        ip === "fd00:ec2::254" ||
        ip === "::"
      )
        return false;
      if (process.env.NODE_ENV === "production") {
        if (
          ip === "127.0.0.1" ||
          hostname === "localhost" ||
          hostname === "::1"
        )
          return false;
      }
      if (
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("172.") ||
        ip.startsWith("fc") ||
        ip.startsWith("fe80")
      ) {
        return false;
      }
    }
    return true;
  } catch (error) {
    console.log("Invalid Url");
    return false;
  }
}

export default isValidWebhookUrl;
