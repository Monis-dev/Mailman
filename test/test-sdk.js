import Mailman from "../src/sdk/index.js";

const client = new Mailman();

const job = await client.dispatch({
  service: "welcome-email",
  target_url: "https://httpbin.org/post",
  payload: { email: "student@university.edu" },
});
console.log("Job Dispatched via SDK", job);

const status = await client.getJobStatus(job.job_id);
console.log(status);
