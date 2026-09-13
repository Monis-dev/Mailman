import autocannon from "autocannon";

let counter = 0;
const runId = Date.now()

async function runBenchmark() {
  const result = await autocannon({
    url: "http://localhost:3000/v1/jobs",
    connections: 50,
    duration: 20,
    method: "POST",

    setupClient(client) {
      client.on("request", () => {
        counter++;
        client.setHeaders({
          "content-type": "application/json",
          "Idempotency-Key": `bench-${runId}-${counter++}`,
        });

        client.setBody(
          JSON.stringify({
            service: "benchamrk",
            target_url: "https://httpbin.org/post",
            payload: { index: counter },
          }),
        );
      });
    },
  });

  console.log(autocannon.printResult(result));
  console.log("Status Code Breakdown:", result.statusCodeStats);
}

runBenchmark();
