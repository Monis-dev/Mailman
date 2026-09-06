import redis from "../config/redis.js";

const STREAM_KEY = "task:stream";
const GROUP_NAME = "worker-group";
const CONSUMERE = 1;
const MAX_ATTEMPTS = 3;

try {
  await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  console.log(`Created group "${GROUP_NAME}" on stream "${STREAM_KEY}"`);
} catch (error) {
  if (error.message.includes("BUSYGROUP")) {
    console.log(`Group "${GROUP_NAME}" already exist`);
  } else {
    throw error;
  }
}

async function processJob(messageId, rawFields) {
  try {
    const fields = {}
    for(let i = 0; i < rawFields.length; i += 2){
      fields[rawFields[i]] = rawFields[i + 1]
    }
    const currentAttempt = fields.attempts ? parseInt(fields.attempts, 10) : 0;
    try {
      const response = await fetch(fields.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: fields.payload,
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
      console.log(`Job ${messageId} succeeded`);
    } catch (error) {
      const nextAttempt = currentAttempt + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await redis.xadd(
          "task:dlq",
          "*",
          "service",
          fields.service,
          "target_url",
          fields.target_url,
          "payload",
          fields.payload,
          "attempts",
          String(nextAttempt),
          "error",
          error.message,
        );
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        console.log(`Job ${messageId} moved to DLQ`);
      } else {
        const delay =
          1000 * 2 ** currentAttempt + Math.floor(Math.random() * 500);
        const wakeUpTime = Date.now() + delay;
        await redis.zadd(
          "task:delayed",
          wakeUpTime,
          JSON.stringify({
            service: fields.service,
            target_url: fields.target_url,
            payload: fields.payload,
            attempts: nextAttempt,
          }),
        );
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        console.log(
          `Job ${messageId} failed. Scheduling retry #${nextAttempt}`,
        );
      }
    }
    console.log(`Processing Job: ${messageId}`, fields);
    
  } catch (error) {
    console.log("Error occured with error: ", error.message)
  }
}

async function startWorker() {
  while (true) {
    try {
      const result = await redis.xreadgroup(
        "GROUP",
        GROUP_NAME,
        CONSUMERE,
        "BLOCK",
        2000,
        "COUNT",
        1,
        "STREAMS",
        STREAM_KEY,
        ">",
      );

      if (result && result.length > 0) {
        const [stream, messages] = result[0];
        for (const [messageId, rawFields] of messages) {
          await processJob(messageId, rawFields)
        }
      }
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function pollDelayJobs() {
  try {
    const now = Date.now();
    const readyJobs = await redis.zrangebyscore("task:delayed", 0, now);
    if (readyJobs.length === 0) return;
    for (const jobString of readyJobs) {
      const job = JSON.parse(jobString);
      await redis.xadd(
        STREAM_KEY,
        "*",
        "service",
        job.service,
        "target_url",
        job.target_url,
        "payload",
        job.payload,
        "attempts",
        job.attempts,
        "error",
        job.error,
      );
      await redis.zrem("task:delayed", jobString);
    }
    console.log(`Job moved to the main stream: ${STREAM_KEY}`);
  } catch (error) {
    console.log(`Unable to move the job to main stream`);
  }
}

async function recoverStuckjobs() {
  try {
    const result = await redis.xautoclaim(
      STREAM_KEY, 
      GROUP_NAME, 
      CONSUMERE,
      5000,
      "0-0",
      "COUNT", 10
    )
    const [nextStartId, claimedMessage, deletedMessageId] = result
    if (claimedMessage.length === 0) return
    for (const [messageId, rawFields] of claimedMessage) {
      console.log(`Recovered abandoned job: ${messageId}`);
      await processJob(messageId, rawFields)
    }
  } catch (error) {
    console.log(error.message)
  }
}

startWorker();
setInterval(pollDelayJobs, 1000);
setInterval(recoverStuckjobs, 10000)