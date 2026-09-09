import redis from "../config/redis.js";

async function canExecute(domain) {
  try {
    const currentState = await redis.get(`circuit:${domain}:state`);
    if (currentState === "OPEN") return false;
    return true;
  } catch (error) {
    console.log("Unable to fetcht the state of circuit error: ", error.message);
  }
}

async function recordSuccess(domain) {
  try {
    await redis.del(`circuit:${domain}:failures`);
    console.log("Reset the failure counter");
  } catch (error) {
    console.log("Record was unsuccessfull error: ", error.message);
  }
}

async function recordFailure(domain) {
  try {
    const failures = await redis.incr(`circuit:${domain}:failures`);
    if (failures === 1) {
      await redis.expire(`circuit:${domain}:failures`, 60);
    }
    if (failures >= 5) {
      await redis.set(`circuit:${domain}:state`, "OPEN", "EX", 30);
      console.log("[CIRCUIT TRIPPED] domain is OPEN for 30 sec");
    }
  } catch (error) {
    console.log("Unable to fetch the circuit status!");
  }
}

export { canExecute, recordSuccess, recordFailure };
