// Circuit breaker to temporarily halt outgoing requests to target domains that are failing repeatedly.

import redis from "../config/redis.js";

// Check if the circuit for a domain is open; if open, stop requests immediately to save resources
async function canExecute(domain) {
  try {
    const currentState = await redis.get(`circuit:${domain}:state`);
    if (currentState === "OPEN") return false;
    return true;
  } catch (error) {
    console.log("Unable to fetcht the state of circuit error: ", error.message);
    return true;
  }
}

// Reset the failure count when a request succeeds
async function recordSuccess(domain) {
  try {
    await redis.del(`circuit:${domain}:failures`);
    console.log("Reset the failure counter");
  } catch (error) {
    console.log("Record was unsuccessfull error: ", error.message);
  }
}

// Track consecutive delivery failures and trip the circuit open when the threshold is hit
async function recordFailure(domain) {
  try {
    const failures = await redis.incr(`circuit:${domain}:failures`);
    // Start a 60-second window on the first recorded failure
    if (failures === 1) {
      await redis.expire(`circuit:${domain}:failures`, 60);
    }
    // If 5 failures occur within the window, open the circuit for 30 seconds
    if (failures >= 5) {
      await redis.set(`circuit:${domain}:state`, "OPEN", "EX", 30);
      console.log("[CIRCUIT TRIPPED] domain is OPEN for 30 sec");
    }
  } catch (error) {
    console.log("Unable to fetch the circuit status!");
  }
}

export { canExecute, recordSuccess, recordFailure };
