// SSRF Protection: Validates target URLs to prevent attacks against internal and cloud infrastructure.

import dotenv from "dotenv";
import dns from "node:dns/promises";

dotenv.config();

async function isValidWebhookUrl(urlString) {
  try {
    const { hostname, protocol } = new URL(urlString);

    // 1. Only allow HTTP and HTTPS
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }

    // 2. ALWAYS block AWS/Cloud metadata IPs in all environments
    if (hostname === "169.254.169.254") return false;

    // 3. Resolve DNS to check the actual IP behind the host
    const addresses = await dns.lookup(hostname, { all: true });

    for (const { address: ip } of addresses) {
      if (
        ip === "169.254.169.254" ||
        ip === "0.0.0.0" ||
        ip === "fd00:ec2::254" ||
        ip === "::"
      ) {
        return false;
      }

      // 4. In PRODUCTION, block loopbacks and private corporate networks:
      if (process.env.NODE_ENV === "production") {
        if (ip === "127.0.0.1" || ip === "::1" || hostname === "localhost") {
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
    }

    return true;
  } catch (error) {
    return false;
  }
}

export default isValidWebhookUrl;
